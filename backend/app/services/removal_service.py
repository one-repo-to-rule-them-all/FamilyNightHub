"""Removing people, and starting a household over (issue #94; ADR-0002 amendment 2026-10-28).

Until now people were never deleted, only merged away. The owner needed a real delete:

- **Remove a person** deletes the person and everything that is theirs: phone bindings, PIN
  requests, attendance, ballots, ratings, photo reactions and the photos they shared. A night's
  winner is stored on the night, so past results keep their winner; tallies and averages lose
  the removed person's votes and stars. Anyone earlier merged into them goes too (those rows are
  already empty: a merge moves everything to the target).
- **Start fresh** does that for every person in the household, plus every phone, TV and night.
  The household, its accounts, settings and the movie library stay.

Both run in the request's one transaction under the household's RLS scope (no bypass), and
both are audited. Photo objects are deleted from the bucket the way an admin photo delete does
it (photo_service.delete): tombstones and row deletes first, objects last, so a storage outage
rolls everything back.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import PhotoStorage, StorageUnavailable
from app.services.errors import Invalid, NotFound, Unavailable


@dataclass(frozen=True)
class RemovalCounts:
    nights_voted: int
    ratings: int
    photos: int
    reactions: int
    phones: int


@dataclass(frozen=True)
class FreshCounts:
    people: int
    phones: int
    nights: int
    photos: int


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    target_type: str,
    target_id: uuid.UUID,
    data: dict[str, Any],
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, :action, :t, :id, CAST(:data AS jsonb))"
        ),
        {
            "h": household_id,
            "a": account_id,
            "action": action,
            "t": target_type,
            "id": target_id,
            "data": json.dumps(data),
        },
    )


async def _delete_photos(
    db: AsyncSession,
    storage: PhotoStorage | None,
    household_id: uuid.UUID,
    where: str,
    params: dict[str, Any],
) -> list[tuple[str, str]]:
    """Tombstone and delete the matching photo rows (reactions cascade). Returns the object
    keys to delete from the bucket once every row is gone."""
    rows = (
        await db.execute(
            text(f"SELECT id, object_key, thumb_key FROM photos WHERE {where}"), params
        )
    ).all()
    if rows and storage is None:
        raise Unavailable("Photo storage is not configured, so their photos can't be deleted")
    for r in rows:
        await db.execute(
            text(
                "INSERT INTO photo_deletions (household_id, photo_id, object_key, thumb_key) "
                "VALUES (:h, :p, :k, :tk)"
            ),
            {"h": household_id, "p": r.id, "k": r.object_key, "tk": r.thumb_key},
        )
    if rows:
        await db.execute(
            text("DELETE FROM photos WHERE id IN :ids").bindparams(
                bindparam("ids", expanding=True)
            ),
            {"ids": [r.id for r in rows]},
        )
    return [(r.object_key, r.thumb_key) for r in rows]


async def _delete_objects(storage: PhotoStorage | None, keys: list[tuple[str, str]]) -> None:
    if not keys or storage is None:
        return
    try:
        for object_key, thumb_key in keys:
            await storage.delete(object_key)
            await storage.delete(thumb_key)
    except StorageUnavailable:
        raise Unavailable("Photo storage is unavailable; try again shortly") from None


async def _lock_person(db: AsyncSession, person_id: uuid.UUID) -> None:
    found = (
        await db.execute(
            text("SELECT id FROM people WHERE id = :p AND merged_into_id IS NULL FOR UPDATE"),
            {"p": person_id},
        )
    ).first()
    if found is None:
        raise NotFound("Person not found")


async def removal_preview(db: AsyncSession, person_id: uuid.UUID) -> RemovalCounts:
    """What removing this person would delete, for the confirm dialog."""
    await _lock_person(db, person_id)
    r = (
        await db.execute(
            text(
                """
                SELECT
                  (SELECT count(DISTINCT session_id) FROM ballot_ranks WHERE person_id = :p) AS nv,
                  (SELECT count(*) FROM ratings WHERE person_id = :p) AS ra,
                  (SELECT count(*) FROM photos WHERE person_id = :p) AS ph,
                  (SELECT count(*) FROM photo_reactions WHERE person_id = :p) AS re,
                  (SELECT count(*) FROM device_people WHERE person_id = :p) AS dp
                """
            ),
            {"p": person_id},
        )
    ).one()
    return RemovalCounts(r.nv, r.ra, r.ph, r.re, r.dp)


async def remove_person(
    db: AsyncSession,
    storage: PhotoStorage | None,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    person_id: uuid.UUID,
) -> RemovalCounts:
    counts = await removal_preview(db, person_id)
    # Rows already merged into this person are empty shells; they go with them.
    ids = [person_id] + [
        r.id
        for r in await db.execute(
            text("SELECT id FROM people WHERE merged_into_id = :p"), {"p": person_id}
        )
    ]
    p = {"ids": ids}

    def run(sql: str) -> Any:
        return db.execute(text(sql).bindparams(bindparam("ids", expanding=True)), p)

    await run("DELETE FROM photo_reactions WHERE person_id IN :ids")
    keys = await _delete_photos(db, storage, household_id, "person_id = ANY(:ids)", p)
    for table in ("ratings", "ballot_ranks", "session_attendance", "pin_reset_requests"):
        await run(f"DELETE FROM {table} WHERE person_id IN :ids")
    await run("DELETE FROM device_people WHERE person_id IN :ids")
    await run("UPDATE people SET merged_into_id = NULL WHERE id IN :ids")
    await run("DELETE FROM people WHERE id IN :ids")
    await _audit(
        db,
        household_id,
        account_id,
        "person.removed",
        "person",
        person_id,
        {
            "nights_voted": counts.nights_voted,
            "ratings": counts.ratings,
            "photos": counts.photos,
            "reactions": counts.reactions,
            "phones": counts.phones,
        },
    )
    await db.flush()
    await _delete_objects(storage, keys)
    return counts


async def start_fresh(
    db: AsyncSession,
    storage: PhotoStorage | None,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    confirm_name: str,
) -> FreshCounts:
    """Clear every person, phone/TV and night in this household. The admin types the
    household's name to confirm (case and surrounding spaces ignored)."""
    name = (
        await db.execute(
            text("SELECT name FROM households WHERE id = :h FOR UPDATE"), {"h": household_id}
        )
    ).scalar_one()
    if confirm_name.strip().casefold() != name.strip().casefold():
        raise Invalid(f'Type the family name exactly: "{name}"')

    async def count(table: str) -> int:
        return int((await db.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one())

    counts = FreshCounts(
        people=await count("people WHERE merged_into_id IS NULL"),
        phones=await count("devices"),
        nights=await count("sessions"),
        photos=await count("photos"),
    )
    await db.execute(text("DELETE FROM photo_reactions"))
    keys = await _delete_photos(db, storage, household_id, "true", {})
    await db.execute(text("UPDATE sessions SET winner_option_id = NULL"))
    for table in (
        "ratings",
        "ballot_ranks",
        "session_attendance",
        "pin_reset_requests",
        "options",
        "sessions",
        "device_people",
        "devices",
    ):
        await db.execute(text(f"DELETE FROM {table}"))
    await db.execute(text("UPDATE people SET merged_into_id = NULL"))
    await db.execute(text("DELETE FROM people"))
    await _audit(
        db,
        household_id,
        account_id,
        "household.started_fresh",
        "household",
        household_id,
        {
            "people": counts.people,
            "phones": counts.phones,
            "nights": counts.nights,
            "photos": counts.photos,
        },
    )
    await db.flush()
    await _delete_objects(storage, keys)
    return counts


__all__ = [
    "FreshCounts",
    "RemovalCounts",
    "remove_person",
    "removal_preview",
    "start_fresh",
]
