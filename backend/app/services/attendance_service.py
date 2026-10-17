"""Who is here tonight (guest-flow spec G8).

A person is *here* once a phone that is currently acting as them (ADR-0014: an active,
current binding to a person with a PIN) opens the night's live stream or casts a ballot as
them, and anyone with a ballot (host proxy votes included) counts too. Rows live in
`session_attendance`; a `presence` hint goes out after commit only when a row is new, so a
phone re-ticketing every minute publishes nothing. Nothing here ever reads or returns ranks.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import night_code
from app.realtime import events
from app.realtime.publisher import publish_after_commit
from app.services.errors import NotFound


@dataclass(frozen=True)
class Present:
    person_id: uuid.UUID
    avatar_emoji: str
    color: str
    voted: bool


async def mark_present(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID, person_id: uuid.UUID
) -> bool:
    """Record the person for a live night; True (and a `presence` hint) only the first time.
    A closed night records nothing: looking at an old album is not being here."""
    inserted = await db.scalar(
        text(
            """
            INSERT INTO session_attendance (household_id, session_id, person_id)
            SELECT :h, s.id, :p FROM sessions s
            WHERE s.id = :s AND s.status = ANY(:live)
            ON CONFLICT (session_id, person_id) DO NOTHING
            RETURNING id
            """
        ),
        {
            "h": household_id,
            "s": session_id,
            "p": person_id,
            "live": sorted(night_code.JOINABLE_STATUSES),
        },
    )
    if inserted is None:
        return False
    publish_after_commit(db, session_id, events.PRESENCE)
    return True


async def mark_device_present(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID, device_id: uuid.UUID
) -> bool:
    """The device's current person (if it may act as them) is here."""
    person_id: uuid.UUID | None = await db.scalar(
        text(
            "SELECT dp.person_id FROM device_people dp JOIN people p "
            "  ON p.id = dp.person_id AND p.household_id = dp.household_id "
            "WHERE dp.device_id = :d AND dp.status = 'active' AND dp.is_current "
            "  AND p.pin_hash IS NOT NULL AND p.merged_into_id IS NULL"
        ),
        {"d": device_id},
    )
    if person_id is None:
        return False
    return await mark_present(db, household_id, session_id, person_id)


async def present(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID
) -> list[Present]:
    """Everyone here: attendance rows plus anyone with a ballot. Avatars and `voted` only."""
    found = await db.scalar(
        text("SELECT 1 FROM sessions WHERE id = :s AND household_id = :h"),
        {"s": session_id, "h": household_id},
    )
    if found is None:
        raise NotFound("Night not found")
    rows = await db.execute(
        text(
            """
            SELECT p.id, p.avatar_emoji, p.color,
                   EXISTS (SELECT 1 FROM ballot_ranks br
                           WHERE br.session_id = :s AND br.person_id = p.id) AS voted
            FROM people p
            WHERE p.merged_into_id IS NULL AND (
                EXISTS (SELECT 1 FROM session_attendance a
                        WHERE a.session_id = :s AND a.person_id = p.id)
                OR EXISTS (SELECT 1 FROM ballot_ranks br
                           WHERE br.session_id = :s AND br.person_id = p.id)
            )
            ORDER BY p.is_guest, lower(p.name)
            """
        ),
        {"s": session_id},
    )
    return [Present(r.id, r.avatar_emoji, r.color, r.voted) for r in rows]
