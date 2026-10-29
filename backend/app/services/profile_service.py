"""A person's history page (ADR-0014 "Profiles"): nights, picks, winners, ratings, photos.

Readable by any device or account of the household; another household's person (RLS) or a
merged one is 404. **Only nights at or past the reveal are included**: a night still in
`draft` or `voting` is left out entirely, so a ballot is never readable before the reveal
(ADR-0006) and the profile is not a back door to who has voted. After the reveal, the
owner decided a person's picks and ratings are family history.

"Picked the winner": for `top3` and `pick_one`, the winner was their rank 1; for
`approval` (whose ordinals mean nothing, ADR-0010), the winner was among their approvals.

A night is listed if they took part in it (`attendance_service.attended_sql`: present or voted,
issue #91), or rated or uploaded to it. `attended` says which: only those may be rated.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import session_state
from app.services.attendance_service import attended_sql
from app.services.errors import NotFound


@dataclass(frozen=True)
class Movie:
    id: uuid.UUID
    title: str
    year: int | None
    poster_path: str | None


@dataclass(frozen=True)
class Pick:
    option_id: uuid.UUID
    rank: int
    movie: Movie


@dataclass(frozen=True)
class Night:
    session_id: uuid.UUID
    title: str | None
    status: str  # effective: revealed, tonight or closed
    voting_method: str
    date: datetime
    winner: Movie | None
    # Empty when they didn't vote that night (they rated or uploaded only).
    picks: list[Pick]
    picked_winner: bool
    rating: int | None
    photo_count: int
    # Took part (present or voted): only then may they rate it.
    attended: bool


@dataclass(frozen=True)
class Album:
    session_id: uuid.UUID
    title: str | None
    photo_count: int


@dataclass(frozen=True)
class Stats:
    nights_joined: int
    ballots_cast: int
    winners_picked: int
    ratings_given: int
    average_rating_given: float | None
    photos_uploaded: int


@dataclass(frozen=True)
class Profile:
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    created_at: datetime
    stats: Stats
    nights: list[Night]
    albums: list[Album]


def _movie(
    movie_id: uuid.UUID | None, title: str | None, year: int | None, poster: str | None
) -> Movie | None:
    if movie_id is None or title is None:
        return None
    return Movie(movie_id, title, year, poster)


async def profile(db: AsyncSession, person_id: uuid.UUID) -> Profile:
    person = (
        await db.execute(
            text(
                "SELECT id, name, avatar_emoji, color, is_guest, created_at FROM people "
                "WHERE id = :p AND merged_into_id IS NULL"
            ),
            {"p": person_id},
        )
    ).first()
    if person is None:
        raise NotFound("Person not found")

    shown = sorted(session_state.RESULT_STATUSES)
    params = {"p": person_id, "shown": shown}
    nights = (
        await db.execute(
            text(
                f"""
                WITH joined AS (
                    SELECT session_id FROM session_attendance WHERE person_id = :p
                    UNION SELECT session_id FROM ballot_ranks WHERE person_id = :p
                    UNION SELECT session_id FROM ratings WHERE person_id = :p
                    UNION SELECT session_id FROM photos WHERE person_id = :p AND status = 'ready'
                )
                SELECT s.id, s.title, s.status, s.voting_method, s.revealed_at, s.created_at,
                       s.winner_option_id, wm.id AS winner_movie_id, wm.title AS winner_title,
                       wm.year AS winner_year, wm.poster_path AS winner_poster, r.score,
                       (SELECT count(*) FROM photos ph WHERE ph.session_id = s.id
                          AND ph.person_id = :p AND ph.status = 'ready') AS photo_count,
                       {attended_sql("s.id", ":p")} AS attended
                FROM sessions s
                JOIN joined j ON j.session_id = s.id
                LEFT JOIN options wo ON wo.id = s.winner_option_id AND wo.session_id = s.id
                LEFT JOIN movies wm ON wm.id = wo.movie_id AND wm.household_id = wo.household_id
                LEFT JOIN ratings r ON r.session_id = s.id AND r.person_id = :p
                WHERE s.status = ANY(:shown)
                ORDER BY COALESCE(s.revealed_at, s.created_at) DESC, s.id
                """
            ),
            params,
        )
    ).all()
    picks: dict[uuid.UUID, list[Pick]] = defaultdict(list)
    for r in await db.execute(
        text(
            """
            SELECT br.session_id, br.option_id, br.rank, m.id AS movie_id, m.title, m.year,
                   m.poster_path
            FROM ballot_ranks br
            JOIN sessions s ON s.id = br.session_id AND s.household_id = br.household_id
            JOIN options o ON o.id = br.option_id AND o.session_id = br.session_id
            JOIN movies m ON m.id = o.movie_id AND m.household_id = o.household_id
            WHERE br.person_id = :p AND s.status = ANY(:shown)
            ORDER BY br.session_id, br.rank
            """
        ),
        params,
    ):
        picks[r.session_id].append(
            Pick(r.option_id, r.rank, Movie(r.movie_id, r.title, r.year, r.poster_path))
        )

    now = datetime.now(UTC)
    out: list[Night] = []
    for n in nights:
        mine = picks.get(n.id, [])
        if n.voting_method == "approval":
            picked = any(p.option_id == n.winner_option_id for p in mine)
        else:
            picked = any(p.rank == 1 and p.option_id == n.winner_option_id for p in mine)
        out.append(
            Night(
                session_id=n.id,
                title=n.title,
                status=session_state.effective_status(n.status, n.revealed_at, now),
                voting_method=n.voting_method,
                date=n.revealed_at or n.created_at,
                winner=_movie(n.winner_movie_id, n.winner_title, n.winner_year, n.winner_poster),
                picks=mine,
                picked_winner=picked,
                rating=n.score,
                photo_count=n.photo_count,
                attended=n.attended,
            )
        )

    scores = [n.rating for n in out if n.rating is not None]
    stats = Stats(
        nights_joined=len(out),
        ballots_cast=sum(1 for n in out if n.picks),
        winners_picked=sum(1 for n in out if n.picked_winner),
        ratings_given=len(scores),
        average_rating_given=round(sum(scores) / len(scores), 2) if scores else None,
        photos_uploaded=sum(n.photo_count for n in out),
    )
    albums = [Album(n.session_id, n.title, n.photo_count) for n in out if n.photo_count]
    return Profile(
        id=person.id,
        name=person.name,
        avatar_emoji=person.avatar_emoji,
        color=person.color,
        is_guest=person.is_guest,
        created_at=person.created_at,
        stats=stats,
        nights=out,
        albums=albums,
    )
