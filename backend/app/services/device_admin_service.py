"""Host-side device control (ADR-0002): enrolling a phone without the night code, pairing
the TV, and approving or rejecting claims on people already bound to another phone.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_device_token, new_token
from app.services import consent_service, device_idle
from app.services.errors import NotFound


@dataclass(frozen=True)
class Enrolled:
    device_id: uuid.UUID
    is_tv: bool
    # Set only when a new device was minted; the caller must put it in the cookie.
    new_token: str | None


@dataclass(frozen=True)
class PendingClaim:
    device_id: uuid.UUID
    device_label: str | None
    person_id: uuid.UUID
    person_name: str
    avatar_emoji: str
    requested_at: datetime


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    target_type: str,
    target_id: uuid.UUID,
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id) VALUES (:h, :a, :action, :tt, :t)"
        ),
        {"h": household_id, "a": account_id, "action": action, "tt": target_type, "t": target_id},
    )


async def enroll(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    existing_device_id: uuid.UUID | None,
    label: str | None,
    as_tv: bool,
) -> Enrolled:
    """Let this browser in on the host's authority. `existing_device_id` is a live device
    of *this* household already held by the browser (resolved by the caller); it is reused
    rather than duplicated. An idle-expired one (issue #56) is revived first, which clears its
    bindings and TV flag, so `as_tv` decides afresh whether it is the TV."""
    if existing_device_id is not None:
        await device_idle.revive_if_expired(db, existing_device_id)
        await db.execute(
            text(
                "UPDATE devices SET is_tv = is_tv OR :tv, label = COALESCE(:l, label), "
                "last_seen_at = now() WHERE id = :d"
            ),
            {"tv": as_tv, "l": label, "d": existing_device_id},
        )
        is_tv: bool = (
            await db.execute(
                text("SELECT is_tv FROM devices WHERE id = :d"), {"d": existing_device_id}
            )
        ).scalar_one()
        await _audit(db, household_id, account_id, "device.enrolled", "device", existing_device_id)
        return Enrolled(existing_device_id, is_tv, None)

    # ADR-0017: no new device until an admin has accepted the Terms as a guardian.
    await consent_service.require_household_consent(db)
    token = new_token()
    device_id: uuid.UUID = (
        await db.execute(
            text(
                "INSERT INTO devices (household_id, token_hash, label, is_tv, last_seen_at) "
                "VALUES (:h, :t, :l, :tv, now()) RETURNING id"
            ),
            {"h": household_id, "t": hash_device_token(token), "l": label, "tv": as_tv},
        )
    ).scalar_one()
    await _audit(db, household_id, account_id, "device.enrolled", "device", device_id)
    return Enrolled(device_id, as_tv, token)


async def pending_claims(db: AsyncSession) -> list[PendingClaim]:
    rows = await db.execute(
        text(
            """
            SELECT dp.device_id, d.label AS device_label, p.id AS person_id,
                   p.name AS person_name, p.avatar_emoji, dp.created_at AS requested_at
            FROM device_people dp
            JOIN devices d ON d.id = dp.device_id AND d.household_id = dp.household_id
            JOIN people p ON p.id = dp.person_id AND p.household_id = dp.household_id
            WHERE dp.status = 'pending' AND d.revoked_at IS NULL
            ORDER BY dp.created_at
            """
        )
    )
    return [
        PendingClaim(
            r.device_id, r.device_label, r.person_id, r.person_name, r.avatar_emoji, r.requested_at
        )
        for r in rows
    ]


@dataclass(frozen=True)
class HelpCount:
    count: int
    # First name of the person in the oldest waiting claim, for "{name} is waiting".
    first_name: str | None


async def help_count(db: AsyncSession) -> HelpCount:
    """Pending person claims on live devices (guest-flow G4: the TV's nudge). PIN resets are
    never counted here: they are admin-only."""
    claims = await pending_claims(db)
    first = claims[0].person_name.split()[0] if claims else None
    return HelpCount(len(claims), first)


async def approve_claim(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
) -> None:
    """Pending -> active, and current on that phone (it asked to act as them). The person
    stays bound to their other phone too (a parent's phone and a kid's tablet can both act
    as the kid). This is the admin override of the PIN (ADR-0014): it works for a person
    without a PIN, who then sets one on that phone before acting as them."""
    pending = await db.scalar(
        text(
            "SELECT id FROM device_people WHERE device_id = :d AND person_id = :p "
            "AND status = 'pending' FOR UPDATE"
        ),
        {"d": device_id, "p": person_id},
    )
    if pending is None:
        raise NotFound
    await db.execute(
        text("UPDATE device_people SET is_current = false WHERE device_id = :d AND is_current"),
        {"d": device_id},
    )
    await db.execute(
        text("UPDATE device_people SET status = 'active', is_current = true WHERE id = :id"),
        {"id": pending},
    )
    await _audit(db, household_id, account_id, "claim.approved", "person", person_id)


async def reject_claim(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
) -> None:
    deleted = await db.execute(
        text(
            "DELETE FROM device_people WHERE device_id = :d AND person_id = :p "
            "AND status = 'pending' RETURNING id"
        ),
        {"d": device_id, "p": person_id},
    )
    if deleted.first() is None:
        raise NotFound
    await _audit(db, household_id, account_id, "claim.rejected", "person", person_id)


# --- Admin "Devices" list (ADR-0002: a lost phone holds a live token until revoked) ---


@dataclass(frozen=True)
class DeviceBinding:
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    status: str


@dataclass(frozen=True)
class DeviceSummary:
    id: uuid.UUID
    label: str | None
    is_tv: bool
    last_seen_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    people: list[DeviceBinding]
    # Live but unused for DEVICE_IDLE_DAYS: needs a night code again (issue #56).
    expired: bool = False


async def list_devices(db: AsyncSession) -> list[DeviceSummary]:
    """Live devices first (most recently seen first), then revoked ones."""
    devices = (
        await db.execute(
            text(
                "SELECT id, label, is_tv, last_seen_at, revoked_at, created_at, "
                f"revoked_at IS NULL AND {device_idle.EXPIRED_SQL} AS expired FROM devices "
                "ORDER BY revoked_at IS NOT NULL, last_seen_at DESC NULLS LAST, created_at DESC"
            ),
            {"cutoff": device_idle.idle_cutoff()},
        )
    ).all()
    bindings: dict[uuid.UUID, list[DeviceBinding]] = {d.id: [] for d in devices}
    rows = await db.execute(
        text(
            """
            SELECT dp.device_id, p.id, p.name, p.avatar_emoji, dp.status
            FROM device_people dp
            JOIN people p ON p.id = dp.person_id AND p.household_id = dp.household_id
            WHERE p.merged_into_id IS NULL
            ORDER BY dp.status, lower(p.name)
            """
        )
    )
    for r in rows:
        bindings[r.device_id].append(DeviceBinding(r.id, r.name, r.avatar_emoji, r.status))
    return [
        DeviceSummary(
            d.id,
            d.label,
            d.is_tv,
            d.last_seen_at,
            d.revoked_at,
            d.created_at,
            bindings[d.id],
            d.expired,
        )
        for d in devices
    ]


async def get_device(db: AsyncSession, device_id: uuid.UUID) -> DeviceSummary:
    for device in await list_devices(db):
        if device.id == device_id:
            return device
    raise NotFound


async def set_label(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    device_id: uuid.UUID,
    label: str | None,
) -> DeviceSummary:
    updated = await db.execute(
        text("UPDATE devices SET label = :l WHERE id = :d RETURNING id"),
        {"l": label, "d": device_id},
    )
    if updated.first() is None:
        raise NotFound
    await _audit(db, household_id, account_id, "device.relabeled", "device", device_id)
    return await get_device(db, device_id)


async def revoke(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, device_id: uuid.UUID
) -> DeviceSummary:
    """Final: there is no un-revoke; the phone rejoins with a night code as a new device.
    The ADR-0009 resolver ignores revoked devices, so the cookie is dead on its next
    request, and its bindings stop counting as "taken" (people_service). Bindings are kept
    for the record. Revoking an already revoked device changes nothing."""
    revoked = await db.execute(
        text(
            "UPDATE devices SET revoked_at = now() WHERE id = :d AND revoked_at IS NULL "
            "RETURNING id"
        ),
        {"d": device_id},
    )
    if revoked.first() is not None:
        await _audit(db, household_id, account_id, "device.revoked", "device", device_id)
    return await get_device(db, device_id)
