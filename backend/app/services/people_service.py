"""Who-are-you: the avatar grid, PINs, and binding people to devices (ADR-0002, ADR-0014).

A device may hold several people (shared phone, "pass to next person") but acts as one at a
time: the binding with `is_current`. Every person has a 6-digit PIN. The phone is the
everyday credential; the PIN gates *claiming* a person (on a new phone) and *switching* to
them (on a shared one). `claim` holds the whole rule set:

- already current on this phone: nothing to do, no PIN;
- the person has a PIN: the right one makes the binding active and current, even if another
  phone holds them too (this replaced host approval); no PIN from a phone that doesn't hold
  them yet asks a host instead (`pending`, the admin override);
- the person has no PIN: the first claim must set it, but only if nobody else holds them,
  this phone already does, or an admin approved a reset this phone asked for. Otherwise
  setting it would be a takeover, so the claim goes `pending`;
- a locked person (5 wrong PINs) refuses every claim until an admin resets the PIN.

Wrong PINs are counted in the request's transaction while the person row is locked
`FOR UPDATE`, so parallel guesses serialize and cannot race past the limit. `WrongPin` and
`PinLocked` are raised *after* the count is written; routers must return their error
response rather than raise, or the transaction would roll the count back.

`require_can_act_as` is the single check ballots, photos and ratings use.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import hashing
from app.domain import credentials
from app.services import people_admin_service
from app.services.errors import (
    Conflict,
    Forbidden,
    Invalid,
    NotFound,
    PinLocked,
    WrongPin,
)

BindingState = Literal["mine", "pending", "taken", "free"]
PinResetState = Literal["open", "approved_for_this_phone"]


@dataclass(frozen=True)
class PersonTile:
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    binding: BindingState
    has_pin: bool
    locked: bool
    # This phone is acting as them right now.
    current: bool
    # They may still change their own name once (only meaningful when current).
    can_rename: bool
    # A forgot-PIN request is waiting for an admin, or one this phone asked for was approved
    # and this phone may now set the new PIN (survives a reload).
    pin_reset: PinResetState | None


@dataclass(frozen=True)
class Claim:
    status: Literal["active", "pending"]
    current: bool


@dataclass(frozen=True)
class ResetRequest:
    id: uuid.UUID
    status: str
    requested_at: datetime


# Bound to another *live* device (revoked devices free their people).
_BOUND_ELSEWHERE = """
    EXISTS (
        SELECT 1 FROM device_people dp JOIN devices d
          ON d.id = dp.device_id AND d.household_id = dp.household_id
        WHERE dp.person_id = p.id AND dp.device_id <> :device
          AND dp.status = 'active' AND d.revoked_at IS NULL
    )
"""

# This device asked for the person's most recent approved PIN reset: it may set the new PIN
# even while another phone still holds them.
_RESET_FOR_ME = """
    EXISTS (
        SELECT 1 FROM pin_reset_requests r
        WHERE r.person_id = p.id AND r.requested_by_device_id = :device
          AND r.status = 'approved'
          AND r.resolved_at = (
              SELECT max(r2.resolved_at) FROM pin_reset_requests r2
              WHERE r2.person_id = p.id AND r2.status = 'approved'
          )
    )
"""


def _tile(r: Any) -> PersonTile:
    binding: BindingState
    if r.my_status == "active":
        binding = "mine"
    elif r.my_status == "pending":
        binding = "pending"
    elif r.taken:
        binding = "taken"
    else:
        binding = "free"
    current = bool(r.my_current) and r.my_status == "active"
    pin_reset: PinResetState | None = None
    if r.pin_hash is None and r.reset_for_me:
        pin_reset = "approved_for_this_phone"
    elif r.reset_open:
        pin_reset = "open"
    return PersonTile(
        id=r.id,
        name=r.name,
        avatar_emoji=r.avatar_emoji,
        color=r.color,
        is_guest=r.is_guest,
        binding=binding,
        has_pin=r.pin_hash is not None,
        locked=r.pin_locked_at is not None,
        current=current,
        can_rename=current and r.pin_hash is not None and r.name_changed_at is None,
        pin_reset=pin_reset,
    )


_TILE_COLUMNS = f"""
    p.id, p.name, p.avatar_emoji, p.color, p.is_guest, p.pin_hash, p.pin_locked_at,
    p.pin_failed_attempts, p.name_changed_at,
    mine.status AS my_status, mine.is_current AS my_current,
    {_BOUND_ELSEWHERE} AS taken,
    {_RESET_FOR_ME} AS reset_for_me,
    EXISTS (
        SELECT 1 FROM pin_reset_requests ro WHERE ro.person_id = p.id AND ro.status = 'open'
    ) AS reset_open
"""
_TILE_FROM = """
    FROM people p
    LEFT JOIN device_people mine ON mine.person_id = p.id AND mine.device_id = :device
"""
_TILE_SQL = f"SELECT {_TILE_COLUMNS} {_TILE_FROM}"


async def list_people(db: AsyncSession, device_id: uuid.UUID) -> list[PersonTile]:
    rows = await db.execute(
        text(_TILE_SQL + " WHERE p.merged_into_id IS NULL ORDER BY p.is_guest, lower(p.name)"),
        {"device": device_id},
    )
    return [_tile(r) for r in rows]


async def get_tile(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> PersonTile:
    row = (
        await db.execute(
            text(_TILE_SQL + " WHERE p.id = :person AND p.merged_into_id IS NULL"),
            {"device": device_id, "person": person_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return _tile(row)


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    action: str,
    person_id: uuid.UUID,
    data: str = "{}",
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_device_id, action, target_type, "
            "target_id, data) VALUES (:h, :d, :action, 'person', :p, CAST(:data AS jsonb))"
        ),
        {"h": household_id, "d": device_id, "action": action, "p": person_id, "data": data},
    )


async def _lock_person(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> Any:
    """The person's PIN state and this device's binding, with the person row locked."""
    row = (
        await db.execute(
            text(
                f"SELECT {_TILE_COLUMNS} {_TILE_FROM} "
                "WHERE p.id = :person AND p.merged_into_id IS NULL FOR UPDATE OF p"
            ),
            {"device": device_id, "person": person_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return row


async def _check_pin(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, person: Any, pin: str
) -> None:
    """Pass, or count the failure and raise. The caller holds the row lock."""
    if person.pin_locked_at is not None:
        raise PinLocked(person.name)
    if await hashing.verify_pin(person.pin_hash, person.id, pin):
        if hashing.needs_rehash(person.pin_hash):
            await _set_pin(db, person.id, pin)
        elif person.pin_failed_attempts:
            await db.execute(
                text("UPDATE people SET pin_failed_attempts = 0 WHERE id = :p"), {"p": person.id}
            )
        return
    failed = person.pin_failed_attempts + 1
    locked = credentials.locks_after(failed)
    await db.execute(
        text(
            "UPDATE people SET pin_failed_attempts = :f, "
            "pin_locked_at = CASE WHEN :locked THEN now() ELSE pin_locked_at END WHERE id = :p"
        ),
        {"f": failed, "locked": locked, "p": person.id},
    )
    await _audit(
        db,
        household_id,
        device_id,
        "person.pin_locked" if locked else "person.pin_failed",
        person.id,
        f'{{"failed_attempts": {failed}}}',
    )
    if locked:
        raise PinLocked(person.name)
    raise WrongPin(person.name, credentials.attempts_left(failed))


async def _set_pin(db: AsyncSession, person_id: uuid.UUID, pin: str) -> None:
    await db.execute(
        text(
            "UPDATE people SET pin_hash = :h, pin_set_at = now(), pin_failed_attempts = 0 "
            "WHERE id = :p"
        ),
        {"h": await hashing.hash_pin(person_id, pin), "p": person_id},
    )


async def _make_current(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, person_id: uuid.UUID
) -> None:
    """Active + current on this device; whoever was current here no longer is. Two
    statements, so the one-current-per-device index never sees two at once."""
    await db.execute(
        text(
            "UPDATE device_people SET is_current = false "
            "WHERE device_id = :d AND is_current AND person_id <> :p"
        ),
        {"d": device_id, "p": person_id},
    )
    await db.execute(
        text(
            "INSERT INTO device_people (household_id, device_id, person_id, status, is_current) "
            "VALUES (:h, :d, :p, 'active', true) ON CONFLICT (device_id, person_id) "
            "DO UPDATE SET status = 'active', is_current = true"
        ),
        {"h": household_id, "d": device_id, "p": person_id},
    )


async def _request_approval(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, person: Any
) -> Claim:
    if person.my_status is None:
        await db.execute(
            text(
                "INSERT INTO device_people (household_id, device_id, person_id, status) "
                "VALUES (:h, :d, :p, 'pending')"
            ),
            {"h": household_id, "d": device_id, "p": person.id},
        )
        await _audit(
            db, household_id, device_id, "person.bound", person.id, '{"status": "pending"}'
        )
    return Claim("pending", False)


async def claim(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    pin: str | None,
) -> Claim:
    """Claim a person for this phone, or switch to one it already holds (module docstring)."""
    person = await _lock_person(db, device_id, person_id)
    mine = person.my_status == "active"
    if mine and person.my_current:
        return Claim("active", True)
    if person.pin_locked_at is not None:
        raise PinLocked(person.name)

    if person.pin_hash is not None:
        if pin is None:
            if mine:
                raise Invalid(f"Enter {person.name}'s PIN to switch to them")
            return await _request_approval(db, household_id, device_id, person)
        await _check_pin(db, household_id, device_id, person, pin)
        await _make_current(db, household_id, device_id, person_id)
        await _audit(db, household_id, device_id, "person.bound", person_id, '{"status": "active"}')
        return Claim("active", True)

    if not (mine or not person.taken or person.reset_for_me):
        return await _request_approval(db, household_id, device_id, person)
    if pin is None:
        raise Invalid(f"Choose a 6-digit PIN for {person.name}")
    await _set_pin(db, person_id, pin)
    await _make_current(db, household_id, device_id, person_id)
    await _audit(db, household_id, device_id, "person.pin_set", person_id)
    await _audit(db, household_id, device_id, "person.bound", person_id, '{"status": "active"}')
    return Claim("active", True)


async def set_pin(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    *,
    new_pin: str,
    current_pin: str | None,
) -> Claim:
    """Set a first PIN for a person this phone holds (people bound before PINs existed, or
    after an admin reset), or change it with the current one. Makes them current."""
    person = await _lock_person(db, device_id, person_id)
    if person.my_status != "active":
        raise Forbidden("This phone isn't set to them")
    if person.pin_hash is not None:
        if current_pin is None:
            raise Invalid(f"Enter {person.name}'s current PIN")
        await _check_pin(db, household_id, device_id, person, current_pin)
    await _set_pin(db, person_id, new_pin)
    await _make_current(db, household_id, device_id, person_id)
    action = "person.pin_changed" if person.pin_hash is not None else "person.pin_set"
    await _audit(db, household_id, device_id, action, person_id)
    return Claim("active", True)


async def create_self(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    *,
    name: str,
    avatar_emoji: str,
    color: str,
    pin: str,
) -> PersonTile:
    """A new profile from a phone that joined with the night code: always a guest (an admin
    converts or merges it later), bound and current here, PIN set in the same transaction."""
    await people_admin_service.lock_names(db, household_id)
    await people_admin_service.require_unique_name(db, name)
    person_id: uuid.UUID = (
        await db.execute(
            text(
                "INSERT INTO people (household_id, name, avatar_emoji, color, is_guest) "
                "VALUES (:h, :n, :e, :c, true) RETURNING id"
            ),
            {"h": household_id, "n": name, "e": avatar_emoji, "c": color},
        )
    ).scalar_one()
    await _set_pin(db, person_id, pin)
    await _make_current(db, household_id, device_id, person_id)
    await _audit(db, household_id, device_id, "person.self_created", person_id)
    return await get_tile(db, device_id, person_id)


async def update_self(
    db: AsyncSession,
    household_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    *,
    name: str | None = None,
    avatar_emoji: str | None = None,
    color: str | None = None,
) -> PersonTile:
    """The person this phone is acting as may change their own name once, and their picture
    (emoji, colour) any number of times. Admin renames (people_admin_service.update) are
    unlimited and don't count. Locks in the admin update's order (names, then the row), so
    the two cannot deadlock."""
    if name is not None:
        await people_admin_service.lock_names(db, household_id)
    row = (
        await db.execute(
            text(
                "SELECT name, name_changed_at, avatar_emoji, color FROM people "
                "WHERE id = :p AND merged_into_id IS NULL FOR UPDATE"
            ),
            {"p": person_id},
        )
    ).first()
    if row is None:
        raise NotFound
    await require_can_act_as(db, device_id, person_id)
    if name is not None and name != row.name:
        if row.name_changed_at is not None:
            raise Conflict("You've already changed your name once. Ask an admin to change it.")
        if name.lower() != row.name.lower():
            await people_admin_service.require_unique_name(db, name, except_id=person_id)
        await db.execute(
            text("UPDATE people SET name = :n, name_changed_at = now() WHERE id = :p"),
            {"n": name, "p": person_id},
        )
        await _audit(db, household_id, device_id, "person.renamed_self", person_id)
    emoji = avatar_emoji if avatar_emoji is not None else row.avatar_emoji
    colour = color if color is not None else row.color
    if (emoji, colour) != (row.avatar_emoji, row.color):
        await db.execute(
            text("UPDATE people SET avatar_emoji = :e, color = :c WHERE id = :p"),
            {"e": emoji, "c": colour, "p": person_id},
        )
        await _audit(db, household_id, device_id, "person.avatar_changed", person_id)
    return await get_tile(db, device_id, person_id)


async def forgot_pin(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, person_id: uuid.UUID
) -> ResetRequest:
    """Ask an admin to reset the person's PIN. Idempotent while a request is open (one open
    request per person, partial unique index)."""
    if (
        await db.scalar(
            text("SELECT 1 FROM people WHERE id = :p AND merged_into_id IS NULL"), {"p": person_id}
        )
        is None
    ):
        raise NotFound
    created = (
        await db.execute(
            text(
                "INSERT INTO pin_reset_requests (household_id, person_id, requested_by_device_id) "
                "VALUES (:h, :p, :d) ON CONFLICT (person_id) WHERE status = 'open' DO NOTHING "
                "RETURNING id, status, created_at"
            ),
            {"h": household_id, "p": person_id, "d": device_id},
        )
    ).first()
    if created is not None:
        await _audit(db, household_id, device_id, "person.pin_reset_requested", person_id)
        return ResetRequest(created.id, created.status, created.created_at)
    existing = (
        await db.execute(
            text(
                "SELECT id, status, created_at FROM pin_reset_requests "
                "WHERE person_id = :p AND status = 'open'"
            ),
            {"p": person_id},
        )
    ).one()
    return ResetRequest(existing.id, existing.status, existing.created_at)


async def unbind(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """Idempotent."""
    await db.execute(
        text("DELETE FROM device_people WHERE device_id = :d AND person_id = :p"),
        {"d": device_id, "p": person_id},
    )


async def require_can_act_as(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """ADR-0002/0014: a device acts only as the person it is *currently* set to, through an
    active binding, and only once that person has a PIN. Host proxy is separate."""
    row = (
        await db.execute(
            text(
                "SELECT dp.is_current, p.pin_hash IS NOT NULL AS has_pin "
                "FROM device_people dp JOIN people p "
                "  ON p.id = dp.person_id AND p.household_id = dp.household_id "
                "WHERE dp.device_id = :d AND dp.person_id = :p AND dp.status = 'active'"
            ),
            {"d": device_id, "p": person_id},
        )
    ).first()
    if row is None:
        raise Forbidden
    if not row.has_pin:
        raise Forbidden("Set a PIN for them on this phone first")
    if not row.is_current:
        raise Forbidden("Switch to them on this phone first (their PIN is needed)")


async def can_act_as(db: AsyncSession, device_id: uuid.UUID, person_id: uuid.UUID) -> bool:
    try:
        await require_can_act_as(db, device_id, person_id)
    except Forbidden:
        return False
    return True
