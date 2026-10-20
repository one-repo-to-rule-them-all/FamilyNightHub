"""Admin side of people (ADR-0002, 05-data.md "Conventions"): add, edit, guests, merge, delete.

A merge repoints every row that names the source person to the target, in the request's one
transaction, then sets `merged_into_id` on the source so it drops out of every list
(`merged_into_id IS NULL` is the "live person" filter everywhere). A **delete** (ADR-0017 §4)
is the other way out: it erases the person, everyone already merged into them, and every row
that names them, photos included (objects deleted from the bucket in the same transaction).

Names are unique per household among live people, case-insensitively ("Sam" and "sam"
are one avatar tile to a five-year-old). The check runs under a per-household advisory
lock, so two admins adding "Sam" at once cannot both win.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import PhotoStorage, StorageUnavailable
from app.services import consent_service
from app.services.errors import Conflict, NotFound, Unavailable


@dataclass(frozen=True)
class Person:
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    created_at: datetime
    has_pin: bool = False
    locked: bool = False


@dataclass(frozen=True)
class PinReset:
    """A "forgot PIN" request as the admin sees it. Never carries a PIN or its hash."""

    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    avatar_emoji: str
    person_locked: bool
    requested_by_device_id: uuid.UUID
    device_label: str | None
    status: str
    requested_at: datetime
    resolved_at: datetime | None


@dataclass(frozen=True)
class MergeResult:
    person: Person
    merged_from_id: uuid.UUID
    ballot_ranks_moved: int
    ballot_ranks_dropped: int
    ratings_moved: int
    ratings_dropped: int
    photos_moved: int
    reactions_moved: int
    reactions_dropped: int
    bindings_moved: int
    bindings_dropped: int


_COLUMNS = (
    "id, name, avatar_emoji, color, is_guest, created_at, "
    "pin_hash IS NOT NULL AS has_pin, pin_locked_at IS NOT NULL AS locked"
)


def _person(r: Any) -> Person:
    return Person(
        r.id, r.name, r.avatar_emoji, r.color, r.is_guest, r.created_at, r.has_pin, r.locked
    )


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    person_id: uuid.UUID,
    data: dict[str, Any] | None = None,
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, :action, 'person', :p, CAST(:data AS jsonb))"
        ),
        {
            "h": household_id,
            "a": account_id,
            "action": action,
            "p": person_id,
            "data": json.dumps(data or {}),
        },
    )


async def lock_names(db: AsyncSession, household_id: uuid.UUID) -> None:
    """Serialize name-uniqueness checks per household until the transaction ends."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended('people:' || :h, 0))"),
        {"h": str(household_id)},
    )


async def require_unique_name(
    db: AsyncSession, name: str, except_id: uuid.UUID | None = None
) -> None:
    taken: str | None = await db.scalar(
        text(
            "SELECT name FROM people WHERE merged_into_id IS NULL AND lower(name) = lower(:n) "
            "AND (CAST(:x AS uuid) IS NULL OR id <> CAST(:x AS uuid))"
        ),
        {"n": name, "x": except_id},
    )
    if taken is not None:
        raise Conflict(f"Someone is already called {taken!r}")


async def _get_live(db: AsyncSession, person_id: uuid.UUID, *, lock: bool = False) -> Person:
    row = (
        await db.execute(
            text(
                f"SELECT {_COLUMNS} FROM people WHERE id = :p AND merged_into_id IS NULL"
                + (" FOR UPDATE" if lock else "")
            ),
            {"p": person_id},
        )
    ).first()
    if row is None:
        raise NotFound("Person not found")
    return _person(row)


async def list_people(db: AsyncSession, *, guests_only: bool = False) -> list[Person]:
    rows = await db.execute(
        text(
            f"SELECT {_COLUMNS} FROM people WHERE merged_into_id IS NULL "
            "AND (NOT :g OR is_guest) ORDER BY is_guest, lower(name)"
        ),
        {"g": guests_only},
    )
    return [_person(r) for r in rows]


async def create(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    name: str,
    avatar_emoji: str,
    color: str,
    is_guest: bool,
) -> Person:
    await consent_service.require_household_consent(db)
    await lock_names(db, household_id)
    await require_unique_name(db, name)
    row = (
        await db.execute(
            text(
                "INSERT INTO people (household_id, name, avatar_emoji, color, is_guest) "
                f"VALUES (:h, :n, :e, :c, :g) RETURNING {_COLUMNS}"
            ),
            {"h": household_id, "n": name, "e": avatar_emoji, "c": color, "g": is_guest},
        )
    ).one()
    person = _person(row)
    await _audit(db, household_id, account_id, "person.created", person.id, {"is_guest": is_guest})
    return person


async def update(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    person_id: uuid.UUID,
    *,
    name: str | None,
    avatar_emoji: str | None,
    color: str | None,
) -> Person:
    """Rename / re-avatar / recolour; fields left None are unchanged. Merged → 404."""
    if name is not None:
        await lock_names(db, household_id)
    current = await _get_live(db, person_id, lock=True)
    if name is not None and name.lower() != current.name.lower():
        await require_unique_name(db, name, except_id=person_id)
    row = (
        await db.execute(
            text(
                "UPDATE people SET name = COALESCE(:n, name), "
                "avatar_emoji = COALESCE(:e, avatar_emoji), color = COALESCE(:c, color) "
                f"WHERE id = :p RETURNING {_COLUMNS}"
            ),
            {"n": name, "e": avatar_emoji, "c": color, "p": person_id},
        )
    ).one()
    changed = [
        field
        for field, value in (("name", name), ("avatar_emoji", avatar_emoji), ("color", color))
        if value is not None
    ]
    await _audit(db, household_id, account_id, "person.updated", person_id, {"fields": changed})
    return _person(row)


async def convert_to_member(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, person_id: uuid.UUID
) -> Person:
    """A guest who keeps coming back becomes family. Idempotent for members."""
    current = await _get_live(db, person_id, lock=True)
    if not current.is_guest:
        return current
    row = (
        await db.execute(
            text(f"UPDATE people SET is_guest = false WHERE id = :p RETURNING {_COLUMNS}"),
            {"p": person_id},
        )
    ).one()
    await _audit(db, household_id, account_id, "person.converted_to_member", person_id)
    return _person(row)


async def merge(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    from_person_id: uuid.UUID,
    into_person_id: uuid.UUID,
) -> MergeResult:
    """Fold `from` into `into` (e.g. the "Grandma" guest from last Friday into Grandma).

    Collisions with the target's own rows are resolved in the target's favour, so the
    result never depends on row order:
    - ballots: in a night where the target has a ballot, the source's whole ballot is
      dropped (mixing two partial top-3 ballots would make an invalid one); otherwise
      it moves.
    - ratings: one per night; the target's wins.
    - photo reactions: (photo, emoji) duplicates collapse into the target's.
    - device bindings: on a device holding both, the target's row is kept and becomes
      `active` if either was (that phone could already act as this human).
    - photos never collide; they all move.
    The target keeps its own name, avatar, colour and guest flag. Anyone previously
    merged into the source is repointed to the target, so merge chains stay one hop.
    """
    if from_person_id == into_person_id:
        raise Conflict("Cannot merge a person into themselves")
    # Lock both rows in id order so two crossing merges cannot deadlock.
    locked = {
        r.id: r
        for r in await db.execute(
            text(
                f"SELECT {_COLUMNS} FROM people WHERE id IN (:a, :b) "
                "AND merged_into_id IS NULL ORDER BY id FOR UPDATE"
            ),
            {"a": from_person_id, "b": into_person_id},
        )
    }
    if from_person_id not in locked or into_person_id not in locked:
        raise NotFound("Person not found")
    params = {"src": from_person_id, "dst": into_person_id}

    async def count(sql: str) -> int:
        return len((await db.execute(text(sql), params)).all())

    ballots_dropped = await count(
        """
        DELETE FROM ballot_ranks s WHERE s.person_id = :src AND EXISTS (
            SELECT 1 FROM ballot_ranks t WHERE t.person_id = :dst AND t.session_id = s.session_id
        ) RETURNING s.id
        """
    )
    ballots_moved = await count(
        "UPDATE ballot_ranks SET person_id = :dst WHERE person_id = :src RETURNING id"
    )
    ratings_dropped = await count(
        """
        DELETE FROM ratings s WHERE s.person_id = :src AND EXISTS (
            SELECT 1 FROM ratings t WHERE t.person_id = :dst AND t.session_id = s.session_id
        ) RETURNING s.id
        """
    )
    ratings_moved = await count(
        "UPDATE ratings SET person_id = :dst WHERE person_id = :src RETURNING id"
    )
    # Who was here (G8): one row per (night, person); the target's wins.
    await db.execute(
        text(
            """
            DELETE FROM session_attendance s WHERE s.person_id = :src AND EXISTS (
                SELECT 1 FROM session_attendance t
                WHERE t.person_id = :dst AND t.session_id = s.session_id
            )
            """
        ),
        params,
    )
    await db.execute(
        text("UPDATE session_attendance SET person_id = :dst WHERE person_id = :src"), params
    )
    photos_moved = await count(
        "UPDATE photos SET person_id = :dst WHERE person_id = :src RETURNING id"
    )
    reactions_dropped = await count(
        """
        DELETE FROM photo_reactions s WHERE s.person_id = :src AND EXISTS (
            SELECT 1 FROM photo_reactions t WHERE t.person_id = :dst
              AND t.photo_id = s.photo_id AND t.emoji = s.emoji
        ) RETURNING s.id
        """
    )
    reactions_moved = await count(
        "UPDATE photo_reactions SET person_id = :dst WHERE person_id = :src RETURNING id"
    )
    await db.execute(
        text(
            """
            UPDATE device_people t SET status = 'active'
            FROM device_people s
            WHERE t.person_id = :dst AND s.person_id = :src AND s.device_id = t.device_id
              AND s.status = 'active' AND t.status <> 'active'
            """
        ),
        params,
    )
    bindings_dropped = await count(
        """
        DELETE FROM device_people s WHERE s.person_id = :src AND EXISTS (
            SELECT 1 FROM device_people t WHERE t.person_id = :dst AND t.device_id = s.device_id
        ) RETURNING s.id
        """
    )
    bindings_moved = await count(
        "UPDATE device_people SET person_id = :dst WHERE person_id = :src RETURNING id"
    )
    await db.execute(
        text("UPDATE people SET merged_into_id = :dst WHERE merged_into_id = :src"), params
    )
    await db.execute(text("UPDATE people SET merged_into_id = :dst WHERE id = :src"), params)

    result = MergeResult(
        person=_person(locked[into_person_id]),
        merged_from_id=from_person_id,
        ballot_ranks_moved=ballots_moved,
        ballot_ranks_dropped=ballots_dropped,
        ratings_moved=ratings_moved,
        ratings_dropped=ratings_dropped,
        photos_moved=photos_moved,
        reactions_moved=reactions_moved,
        reactions_dropped=reactions_dropped,
        bindings_moved=bindings_moved,
        bindings_dropped=bindings_dropped,
    )
    await _audit(
        db,
        household_id,
        account_id,
        "person.merged",
        into_person_id,
        {
            "from": str(from_person_id),
            "into": str(into_person_id),
            "ballot_ranks": [ballots_moved, ballots_dropped],
            "ratings": [ratings_moved, ratings_dropped],
            "photos": photos_moved,
            "reactions": [reactions_moved, reactions_dropped],
            "bindings": [bindings_moved, bindings_dropped],
        },
    )
    return result


@dataclass(frozen=True)
class DeletedPerson:
    person_id: uuid.UUID
    photos: int
    ballot_ranks: int
    ratings: int


async def delete(
    db: AsyncSession,
    storage: PhotoStorage | None,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    person_id: uuid.UUID,
) -> DeletedPerson:
    """Erase a person (ADR-0017 §4): their photos (tombstoned for the backup purge, objects
    deleted last so a storage outage rolls everything back), reactions, ballots, ratings,
    attendance, phone bindings and PIN resets; anyone merged into them; and the names in their
    audit rows. The audit keeps that a person was deleted and the counts, never who.

    Ballots go too, so a past night's tally can change; its recorded winner doesn't."""
    await _get_live(db, person_id, lock=True)
    ids = [
        r.id
        for r in await db.execute(
            text("SELECT id FROM people WHERE id = :p OR merged_into_id = :p ORDER BY id"),
            {"p": person_id},
        )
    ]
    params: dict[str, Any] = {"ids": ids, "h": household_id}
    photos = (
        await db.execute(
            text(
                "SELECT id, object_key, thumb_key FROM photos WHERE person_id = ANY(:ids) "
                "ORDER BY id FOR UPDATE"
            ),
            params,
        )
    ).all()
    if photos and storage is None:
        raise Unavailable("Photo storage is unavailable; try again shortly")
    for photo in photos:
        await db.execute(
            text(
                "INSERT INTO photo_deletions (household_id, photo_id, object_key, thumb_key) "
                "VALUES (:h, :p, :k, :tk)"
            ),
            {"h": household_id, "p": photo.id, "k": photo.object_key, "tk": photo.thumb_key},
        )

    async def erase(table: str) -> int:
        result = await db.execute(
            text(f"DELETE FROM {table} WHERE person_id = ANY(:ids) RETURNING id"), params
        )
        return len(result.all())

    # Photos first: their reactions (anyone's) cascade with them.
    photo_count = await erase("photos")
    await erase("photo_reactions")
    ballot_ranks = await erase("ballot_ranks")
    ratings = await erase("ratings")
    await erase("session_attendance")
    await erase("device_people")
    await erase("pin_reset_requests")
    await db.execute(text("DELETE FROM people WHERE merged_into_id = :p"), {"p": person_id})
    await db.execute(text("DELETE FROM people WHERE id = :p"), {"p": person_id})
    # Names and renames live in `data`; the rows themselves stay as a record of what happened.
    await db.execute(
        text(
            "UPDATE audit_events SET data = '{\"redacted\": true}'::jsonb "
            "WHERE target_id = ANY(:ids)"
        ),
        params,
    )
    await _audit(
        db,
        household_id,
        account_id,
        "person.deleted",
        person_id,
        {
            "photos": photo_count,
            "ballot_ranks": ballot_ranks,
            "ratings": ratings,
            "merged": len(ids) - 1,
        },
    )
    if photos and storage is not None:
        await db.flush()
        try:
            for photo in photos:
                await storage.delete(photo.object_key)
                await storage.delete(photo.thumb_key)
        except StorageUnavailable:
            raise Unavailable("Photo storage is unavailable; try again shortly") from None
    return DeletedPerson(person_id, photo_count, ballot_ranks, ratings)


# --- PIN resets (ADR-0014) ---------------------------------------------------------

_RESET_SQL = """
    SELECT r.id, r.person_id, p.name AS person_name, p.avatar_emoji,
           p.pin_locked_at IS NOT NULL AS person_locked, r.requested_by_device_id,
           d.label AS device_label, r.status, r.created_at AS requested_at, r.resolved_at
    FROM pin_reset_requests r
    JOIN people p ON p.id = r.person_id AND p.household_id = r.household_id
    JOIN devices d ON d.id = r.requested_by_device_id AND d.household_id = r.household_id
    WHERE p.merged_into_id IS NULL
"""


def _reset(r: Any) -> PinReset:
    return PinReset(
        r.id,
        r.person_id,
        r.person_name,
        r.avatar_emoji,
        r.person_locked,
        r.requested_by_device_id,
        r.device_label,
        r.status,
        r.requested_at,
        r.resolved_at,
    )


async def list_pin_resets(db: AsyncSession) -> list[PinReset]:
    """Open requests, oldest first (the admin portal's queue)."""
    rows = await db.execute(text(_RESET_SQL + " AND r.status = 'open' ORDER BY r.created_at"))
    return [_reset(r) for r in rows]


async def open_pin_reset_count(db: AsyncSession) -> int:
    """The admin nav badge (G4): open requests for unmerged people."""
    count: int = await db.scalar(
        text(
            "SELECT count(*) FROM pin_reset_requests r JOIN people p "
            "ON p.id = r.person_id AND p.household_id = r.household_id "
            "WHERE r.status = 'open' AND p.merged_into_id IS NULL"
        )
    )
    return count


async def _resolve_reset(
    db: AsyncSession, account_id: uuid.UUID, request_id: uuid.UUID, status: str
) -> uuid.UUID:
    """Close an open request; the person's id. Unknown/other household 404, closed 409."""
    row = (
        await db.execute(
            text(
                "SELECT r.status, r.person_id FROM pin_reset_requests r JOIN people p "
                "ON p.id = r.person_id AND p.household_id = r.household_id "
                "WHERE r.id = :r AND p.merged_into_id IS NULL FOR UPDATE OF r"
            ),
            {"r": request_id},
        )
    ).first()
    if row is None:
        raise NotFound("PIN reset request not found")
    if row.status != "open":
        raise Conflict("This request was already handled")
    await db.execute(
        text(
            "UPDATE pin_reset_requests SET status = :s, resolved_at = now(), "
            "resolved_by_account_id = :a WHERE id = :r"
        ),
        {"s": status, "a": account_id, "r": request_id},
    )
    person_id: uuid.UUID = row.person_id
    return person_id


async def _get_reset(db: AsyncSession, request_id: uuid.UUID) -> PinReset:
    return _reset((await db.execute(text(_RESET_SQL + " AND r.id = :r"), {"r": request_id})).one())


async def approve_pin_reset(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, request_id: uuid.UUID
) -> PinReset:
    """Clear the PIN, the failure count and the lock. The admin never sees or picks a PIN:
    the person sets a new one on their next claim (people_service)."""
    person_id = await _resolve_reset(db, account_id, request_id, "approved")
    await db.execute(
        text(
            "UPDATE people SET pin_hash = NULL, pin_set_at = NULL, pin_failed_attempts = 0, "
            "pin_locked_at = NULL WHERE id = :p"
        ),
        {"p": person_id},
    )
    await _audit(
        db, household_id, account_id, "person.pin_reset", person_id, {"request": str(request_id)}
    )
    return await _get_reset(db, request_id)


async def dismiss_pin_reset(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, request_id: uuid.UUID
) -> PinReset:
    person_id = await _resolve_reset(db, account_id, request_id, "dismissed")
    await _audit(
        db,
        household_id,
        account_id,
        "person.pin_reset_dismissed",
        person_id,
        {"request": str(request_id)},
    )
    return await _get_reset(db, request_id)
