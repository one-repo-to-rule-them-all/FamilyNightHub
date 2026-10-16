"""Admin side of people (ADR-0002, 05-data.md "Conventions"): add, edit, guests, merge.

People are never deleted. A merge repoints every row that names the source person to the
target, in the request's one transaction, then sets `merged_into_id` on the source so it
drops out of every list (`merged_into_id IS NULL` is the "live person" filter everywhere).

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

from app.services.errors import Conflict, NotFound


@dataclass(frozen=True)
class Person:
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    created_at: datetime


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


_COLUMNS = "id, name, avatar_emoji, color, is_guest, created_at"


def _person(r: Any) -> Person:
    return Person(r.id, r.name, r.avatar_emoji, r.color, r.is_guest, r.created_at)


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


async def _lock_names(db: AsyncSession, household_id: uuid.UUID) -> None:
    """Serialize name-uniqueness checks per household until the transaction ends."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended('people:' || :h, 0))"),
        {"h": str(household_id)},
    )


async def _require_unique_name(
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
    await _lock_names(db, household_id)
    await _require_unique_name(db, name)
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
        await _lock_names(db, household_id)
    current = await _get_live(db, person_id, lock=True)
    if name is not None and name.lower() != current.name.lower():
        await _require_unique_name(db, name, except_id=person_id)
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
