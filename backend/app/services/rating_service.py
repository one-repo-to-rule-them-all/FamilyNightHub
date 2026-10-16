"""Ratings: each person scores the night's movie 1–5 after watching (BUILD-PROMPT Phase 2).

One row per (session, person); rating again replaces the score. A phone rates as a person
actively bound to it (`people_service.require_can_act_as`); a host with `ballots:proxy`
rates for anyone (kids without phones), attributed by a `rating.proxy_rated` audit row.
Ratings open once the night's *effective* status is `tonight` (a settled reveal counts) and
stay open after `closed`. Readers only ever see their own people's scores and the family
average; never another person's score.

`average_rating` is the read the candidate generator uses (ADR-0007: a title watched in the
last 12 months is skipped unless its average family rating is 4 or higher).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import session_state
from app.domain.session_state import SessionRuleError
from app.realtime import events
from app.realtime.publisher import publish_after_commit
from app.services import people_service
from app.services.errors import Conflict, NotFound


@dataclass(frozen=True)
class RatingAverage:
    # None when nobody has rated yet.
    average: float | None
    count: int


@dataclass(frozen=True)
class OwnRating:
    person_id: uuid.UUID
    # None until this person has rated.
    score: int | None


async def _check_open(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> None:
    """NotFound for another household's (or no) night; Conflict until ratings open. The row
    is read `FOR SHARE` so a rating and a host's status change serialize."""
    row = (
        await db.execute(
            text(
                "SELECT status, revealed_at FROM sessions "
                "WHERE id = :s AND household_id = :h FOR SHARE"
            ),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    effective = session_state.effective_status(row.status, row.revealed_at, datetime.now(UTC))
    try:
        session_state.check_can_rate(effective)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None


async def rate(
    db: AsyncSession,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    person_id: uuid.UUID,
    score: int,
    *,
    device_id: uuid.UUID | None = None,
    proxy_account_id: uuid.UUID | None = None,
) -> None:
    """Set or replace `person_id`'s score for the night. Exactly one of device_id (a phone
    rating as a person actively bound to it) or proxy_account_id (a host with
    `ballots:proxy`) is given."""
    assert (device_id is None) != (proxy_account_id is None)
    await _check_open(db, household_id, session_id)
    if device_id is not None:
        await people_service.require_can_act_as(db, device_id, person_id)
    else:
        person = await db.scalar(
            text(
                "SELECT 1 FROM people WHERE id = :p AND household_id = :h "
                "AND merged_into_id IS NULL"
            ),
            {"p": person_id, "h": household_id},
        )
        if person is None:
            raise NotFound("Person not found")

    await db.execute(
        text(
            "INSERT INTO ratings (household_id, session_id, person_id, score) "
            "VALUES (:h, :s, :p, :score) "
            "ON CONFLICT (session_id, person_id) DO UPDATE SET score = EXCLUDED.score"
        ),
        {"h": household_id, "s": session_id, "p": person_id, "score": score},
    )
    if proxy_account_id is not None:
        # Who rated for whom is auditable; the score itself stays out of the log.
        await db.execute(
            text(
                "INSERT INTO audit_events (household_id, actor_account_id, action, "
                "target_type, target_id, data) VALUES (:h, :a, 'rating.proxy_rated', "
                "'session', :s, jsonb_build_object('person_id', CAST(:p AS text)))"
            ),
            {"h": household_id, "a": proxy_account_id, "s": session_id, "p": str(person_id)},
        )
    publish_after_commit(db, session_id, events.RATING_COUNT)


async def own_ratings(
    db: AsyncSession, household_id: uuid.UUID, device_id: uuid.UUID, session_id: uuid.UUID
) -> list[OwnRating]:
    """The scores of the people actively bound to this device (pending claims excluded)."""
    found = await db.scalar(
        text("SELECT 1 FROM sessions WHERE id = :s AND household_id = :h"),
        {"s": session_id, "h": household_id},
    )
    if found is None:
        raise NotFound
    rows = await db.execute(
        text(
            """
            SELECT dp.person_id, r.score
            FROM device_people dp
            JOIN people p ON p.id = dp.person_id
            LEFT JOIN ratings r ON r.person_id = dp.person_id AND r.session_id = :s
            WHERE dp.device_id = :d AND dp.status = 'active' AND p.merged_into_id IS NULL
            ORDER BY p.is_guest, lower(p.name), dp.person_id
            """
        ),
        {"s": session_id, "d": device_id},
    )
    return [OwnRating(r.person_id, r.score) for r in rows]


async def session_average(db: AsyncSession, session_id: uuid.UUID) -> RatingAverage:
    """The family's average score for one night (callers gate it on `shows_rating`)."""
    row = (
        await db.execute(
            text("SELECT avg(score) AS average, count(*) AS n FROM ratings WHERE session_id = :s"),
            {"s": session_id},
        )
    ).one()
    return RatingAverage(None if row.average is None else float(row.average), int(row.n))


async def average_rating(
    db: AsyncSession, movie_id: uuid.UUID, since: datetime
) -> RatingAverage | None:
    """The family's average score for `movie_id` over the nights it won since `since`
    (a night counts from its reveal), or None if it hasn't been rated in that window.

    For the candidate generator (ADR-0007). `movie_id` is a household's library row, and the
    caller's transaction carries that household's GUC, so RLS scopes the read."""
    row = (
        await db.execute(
            text(
                """
                SELECT avg(r.score) AS average, count(*) AS n
                FROM ratings r
                JOIN sessions s ON s.id = r.session_id AND s.household_id = r.household_id
                JOIN options o ON o.id = s.winner_option_id AND o.session_id = s.id
                WHERE o.movie_id = :m
                  AND s.status IN ('revealed', 'tonight', 'closed')
                  AND coalesce(s.revealed_at, s.created_at) >= :since
                """
            ),
            {"m": movie_id, "since": since},
        )
    ).one()
    if row.n == 0:
        return None
    return RatingAverage(float(row.average), int(row.n))
