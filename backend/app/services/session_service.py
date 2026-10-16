"""Nights: create, night code, shortlist, open/close voting, reveal, history (03-backend.md).

Rules come from app/domain/session_state.py; this module loads, locks and persists. Every
mutation takes the session row `FOR UPDATE` first, so two hosts racing (adding the 9th
option, opening twice) serialize on it. Every state change writes an audit row. The
night code is returned in plaintext exactly once, by `create` and `rotate_code`; only its
peppered hash is stored. The snapshot never carries ballots, and carries the ranking
and winner only from reveal on (ADR-0004/0006). `revealed -> tonight` is lazy: readers see
`tonight` 30s after reveal, and the next write through `_lock` persists it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_night_code
from app.domain import night_code, session_state
from app.domain.session_state import SessionRuleError
from app.domain.voting import METHODS
from app.integrations.tmdb import TmdbClient
from app.realtime import events
from app.realtime.publisher import publish_after_commit
from app.services import movie_service, rating_service
from app.services.errors import Conflict, NotFound
from app.services.rating_service import RatingAverage

# A fresh code colliding with another live night of the same household is ~1 in 887M;
# retry a couple of times rather than fail the host.
_CODE_ATTEMPTS = 3


@dataclass(frozen=True)
class CreatedNight:
    session_id: uuid.UUID
    night_code: str


@dataclass(frozen=True)
class OptionView:
    id: uuid.UUID
    movie_id: uuid.UUID
    title: str
    year: int | None
    poster_path: str | None
    source: str
    position: int


@dataclass(frozen=True)
class Placement:
    option_id: uuid.UUID
    place: int
    score: int
    first_places: int


@dataclass(frozen=True)
class VotingResult:
    """The stored outcome of close_voting; shown from reveal on."""

    winner_option_id: uuid.UUID
    tie_seed: int
    tie_group: list[uuid.UUID]
    tiebreak: str
    ballot_count: int
    placements: list[Placement]


@dataclass(frozen=True)
class Snapshot:
    id: uuid.UUID
    title: str | None
    status: str
    voting_method: str
    # Fixed when voting opens (ADR-0006); None while the shortlist is still a draft.
    ballot_size: int | None
    options: list[OptionView]
    created_at: datetime
    voting_opened_at: datetime | None
    revealed_at: datetime | None
    closed_at: datetime | None
    # None until the night is revealed (ADR-0006: tallies are hidden while voting).
    result: VotingResult | None
    # The family average; None until ratings open (`tonight`/`closed`).
    rating: RatingAverage | None


@dataclass(frozen=True)
class Winner:
    option_id: uuid.UUID
    movie_id: uuid.UUID
    title: str
    year: int | None
    poster_path: str | None


@dataclass(frozen=True)
class NightSummary:
    id: uuid.UUID
    title: str | None
    status: str
    created_at: datetime
    revealed_at: datetime | None
    closed_at: datetime | None
    winner: Winner | None
    turnout: int
    rating: RatingAverage | None


@dataclass(frozen=True)
class OptionInput:
    """Exactly one of movie_id, tmdb_id or title is set (enforced by the schema)."""

    movie_id: uuid.UUID | None = None
    tmdb_id: int | None = None
    title: str | None = None
    year: int | None = None
    # With tmdb_id: `streaming` when the generator found it on a household service.
    source: str | None = None


_AUDIT = text(
    "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
    "target_id, data) VALUES (:h, :a, :action, 'session', :t, :data)"
).bindparams(bindparam("data", type_=JSONB))


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    session_id: uuid.UUID,
    data: dict[str, Any] | None = None,
) -> None:
    await db.execute(
        _AUDIT,
        {"h": household_id, "a": account_id, "action": action, "t": session_id, "data": data or {}},
    )


async def _lock(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, session_id: uuid.UUID
) -> str:
    """Lock the session row and return its status; NotFound if absent or not ours.
    A reveal that readers already see as `tonight` is persisted here (the lazy settle)."""
    row = (
        await db.execute(
            text(
                "SELECT status, revealed_at FROM sessions "
                "WHERE id = :s AND household_id = :h FOR UPDATE"
            ),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    status: str = row.status
    settled = session_state.settle(status, row.revealed_at, datetime.now(UTC))
    if settled is None:
        return status
    await db.execute(
        text("UPDATE sessions SET status = :st WHERE id = :s"), {"st": settled, "s": session_id}
    )
    await _audit(
        db, household_id, account_id, "session.settled", session_id, {"from": status, "to": settled}
    )
    return settled


async def _option_ids(db: AsyncSession, session_id: uuid.UUID) -> list[uuid.UUID]:
    rows = await db.execute(
        text("SELECT id FROM options WHERE session_id = :s ORDER BY position, created_at"),
        {"s": session_id},
    )
    return [r.id for r in rows]


def _rule(check: Any, *args: Any) -> None:
    try:
        check(*args)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None


async def _set_code(
    db: AsyncSession, household_id: uuid.UUID, write: Any, generate: Any
) -> tuple[str, Any]:
    """Run `write(code_hash)` with a fresh code, retrying on the live-code unique index."""
    for attempt in range(_CODE_ATTEMPTS):
        code = generate()
        try:
            async with db.begin_nested():
                result = await write(hash_night_code(code, household_id))
        except IntegrityError:
            if attempt == _CODE_ATTEMPTS - 1:
                raise
            continue
        return code, result
    raise AssertionError("unreachable")  # pragma: no cover


async def create(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    title: str | None,
    generate: Any = night_code.generate,
) -> CreatedNight:
    async def write(code_hash: str) -> uuid.UUID:
        new_id: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO sessions (household_id, title, night_code_hash, "
                    "host_account_id) VALUES (:h, :t, :c, :a) RETURNING id"
                ),
                {"h": household_id, "t": title, "c": code_hash, "a": account_id},
            )
        ).scalar_one()
        return new_id

    code, session_id = await _set_code(db, household_id, write, generate)
    await _audit(db, household_id, account_id, "session.created", session_id)
    return CreatedNight(session_id, code)


async def rotate_code(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    generate: Any = night_code.generate,
) -> str:
    """New code, old one stops working. Phones already joined keep their device cookie."""
    _rule(
        session_state.check_can_rotate_code, await _lock(db, household_id, account_id, session_id)
    )

    async def write(code_hash: str) -> None:
        await db.execute(
            text("UPDATE sessions SET night_code_hash = :c WHERE id = :s"),
            {"c": code_hash, "s": session_id},
        )

    code, _ = await _set_code(db, household_id, write, generate)
    await _audit(db, household_id, account_id, "session.code_rotated", session_id)
    return code


async def add_option(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    session_id: uuid.UUID,
    choice: OptionInput,
    client: TmdbClient | None,
) -> uuid.UUID:
    status = await _lock(db, household_id, account_id, session_id)
    existing = await _option_ids(db, session_id)
    _rule(session_state.check_can_add_option, status, len(existing))

    if choice.movie_id is not None:
        row = (
            await db.execute(
                text("SELECT tmdb_id, owned FROM movies WHERE id = :m AND household_id = :h"),
                {"m": choice.movie_id, "h": household_id},
            )
        ).first()
        if row is None:
            raise NotFound("Movie not found")
        movie_id = choice.movie_id
        source = "owned" if row.owned else ("tmdb" if row.tmdb_id is not None else "manual")
    elif choice.tmdb_id is not None:
        movie_id = await movie_service.upsert_from_tmdb(db, household_id, client, choice.tmdb_id)
        source = choice.source or "tmdb"
    else:
        assert choice.title is not None
        movie_id = await movie_service.upsert_manual(db, household_id, choice.title, choice.year)
        source = "manual"

    try:
        async with db.begin_nested():
            option_id: uuid.UUID = (
                await db.execute(
                    text(
                        "INSERT INTO options (household_id, session_id, movie_id, source, "
                        "position) VALUES (:h, :s, :m, :src, :pos) RETURNING id"
                    ),
                    {
                        "h": household_id,
                        "s": session_id,
                        "m": movie_id,
                        "src": source,
                        "pos": len(existing),
                    },
                )
            ).scalar_one()
    except IntegrityError:
        raise Conflict("That movie is already on the shortlist") from None
    await _audit(
        db,
        household_id,
        account_id,
        "session.option_added",
        session_id,
        {"option_id": str(option_id), "movie_id": str(movie_id), "source": source},
    )
    publish_after_commit(db, session_id, events.SHORTLIST_CHANGED)
    return option_id


async def remove_option(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    session_id: uuid.UUID,
    option_id: uuid.UUID,
) -> None:
    _rule(
        session_state.check_shortlist_editable,
        await _lock(db, household_id, account_id, session_id),
    )
    deleted = await db.execute(
        text("DELETE FROM options WHERE id = :o AND session_id = :s RETURNING id"),
        {"o": option_id, "s": session_id},
    )
    if deleted.first() is None:
        raise NotFound("Option not found")
    await _renumber(db, await _option_ids(db, session_id))
    await _audit(
        db,
        household_id,
        account_id,
        "session.option_removed",
        session_id,
        {"option_id": str(option_id)},
    )
    publish_after_commit(db, session_id, events.SHORTLIST_CHANGED)


async def _renumber(db: AsyncSession, ordered: list[uuid.UUID]) -> None:
    for position, oid in enumerate(ordered):
        await db.execute(
            text("UPDATE options SET position = :p WHERE id = :o"), {"p": position, "o": oid}
        )


async def reorder(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    session_id: uuid.UUID,
    ordered: list[uuid.UUID],
) -> None:
    status = await _lock(db, household_id, account_id, session_id)
    _rule(session_state.check_shortlist_editable, status)
    current = await _option_ids(db, session_id)
    _rule(session_state.check_reorder, [str(o) for o in current], [str(o) for o in ordered])
    await _renumber(db, ordered)
    await _audit(db, household_id, account_id, "session.reordered", session_id)
    publish_after_commit(db, session_id, events.SHORTLIST_CHANGED)


async def open_voting(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, session_id: uuid.UUID
) -> None:
    status = await _lock(db, household_id, account_id, session_id)
    count = len(await _option_ids(db, session_id))
    try:
        opened = session_state.open_voting(status, count)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None
    await db.execute(
        text(
            "UPDATE sessions SET status = :st, ballot_size = :k, voting_opened_at = now() "
            "WHERE id = :s"
        ),
        {"st": opened.status, "k": opened.ballot_size, "s": session_id},
    )
    await _audit(
        db,
        household_id,
        account_id,
        "session.voting_opened",
        session_id,
        {"from": status, "to": opened.status, "options": count, "ballot_size": opened.ballot_size},
    )
    publish_after_commit(db, session_id, events.STATUS_CHANGED)


async def _ballots(db: AsyncSession, session_id: uuid.UUID) -> list[dict[str, int]]:
    rows = await db.execute(
        text("SELECT person_id, option_id, rank FROM ballot_ranks WHERE session_id = :s"),
        {"s": session_id},
    )
    by_person: dict[uuid.UUID, dict[str, int]] = {}
    for r in rows:
        by_person.setdefault(r.person_id, {})[str(r.option_id)] = r.rank
    return list(by_person.values())


_REVEAL = text(
    "UPDATE sessions SET status = :st, ranking = :ranking, tie_seed = :seed, "
    "winner_option_id = :w, revealed_at = now() WHERE id = :s"
).bindparams(bindparam("ranking", type_=JSONB))


async def close_voting(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    seed: int,
) -> None:
    """voting -> revealed: tally, tie-break, then store ranking + seed + winner in this one
    transaction (ADR-0006). Idempotent: once revealed, a repeat (or a racing second host,
    serialized on the row lock) changes nothing and the first result stands."""
    status = await _lock(db, household_id, account_id, session_id)
    try:
        new_status = session_state.close_voting(status)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None
    if new_status is None:
        return
    method: str = await db.scalar(
        text("SELECT voting_method FROM sessions WHERE id = :s"), {"s": session_id}
    )
    options = [str(o) for o in await _option_ids(db, session_id)]
    ranking = METHODS[method](options, await _ballots(db, session_id), seed=seed)
    await db.execute(
        _REVEAL,
        {
            "st": new_status,
            "ranking": ranking.to_json(),
            "seed": ranking.seed,
            "w": uuid.UUID(ranking.winner),
            "s": session_id,
        },
    )
    await _audit(
        db,
        household_id,
        account_id,
        "session.voting_closed",
        session_id,
        {
            "from": status,
            "to": new_status,
            "ballots": ranking.ballot_count,
            "winner_option_id": ranking.winner,
            "tiebreak": ranking.tiebreak,
        },
    )
    publish_after_commit(db, session_id, events.REVEALED)


async def close(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, session_id: uuid.UUID
) -> None:
    """tonight -> closed: the night code stops joining. Idempotent once closed."""
    status = await _lock(db, household_id, account_id, session_id)
    try:
        new_status = session_state.close_night(status)
    except SessionRuleError as err:
        raise Conflict(err.reason) from None
    if new_status is None:
        return
    await db.execute(
        text("UPDATE sessions SET status = :st, closed_at = now() WHERE id = :s"),
        {"st": new_status, "s": session_id},
    )
    await _audit(
        db,
        household_id,
        account_id,
        "session.closed",
        session_id,
        {"from": status, "to": new_status},
    )
    publish_after_commit(db, session_id, events.STATUS_CHANGED)


def _result(row: Any) -> VotingResult | None:
    """The stored outcome, but only once the night is revealed (ADR-0006)."""
    if not session_state.shows_result(row.status) or row.ranking is None:
        return None
    ranking: dict[str, Any] = row.ranking
    return VotingResult(
        winner_option_id=row.winner_option_id,
        tie_seed=int(row.tie_seed),
        tie_group=[uuid.UUID(o) for o in ranking["tie_group"]],
        tiebreak=ranking["tiebreak"],
        ballot_count=ranking["ballot_count"],
        placements=[
            Placement(uuid.UUID(p["option_id"]), p["place"], p["score"], p["first_places"])
            for p in ranking["placements"]
        ],
    )


async def snapshot(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> Snapshot:
    row = (
        await db.execute(
            text(
                "SELECT id, title, status, voting_method, ballot_size, created_at, "
                "voting_opened_at, revealed_at, closed_at, ranking, tie_seed, "
                "winner_option_id FROM sessions WHERE id = :s AND household_id = :h"
            ),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    options = await db.execute(
        text(
            """
            SELECT o.id, o.movie_id, m.title, m.year, m.poster_path, o.source, o.position
            FROM options o
            JOIN movies m ON m.id = o.movie_id AND m.household_id = o.household_id
            WHERE o.session_id = :s
            ORDER BY o.position, o.created_at
            """
        ),
        {"s": session_id},
    )
    status: str = row.status
    effective = session_state.effective_status(status, row.revealed_at, datetime.now(UTC))
    rating = None
    if session_state.shows_rating(effective):
        rating = await rating_service.session_average(db, session_id)
    return Snapshot(
        id=row.id,
        title=row.title,
        status=effective,
        voting_method=row.voting_method,
        ballot_size=None if status == "draft" else row.ballot_size,
        options=[
            OptionView(o.id, o.movie_id, o.title, o.year, o.poster_path, o.source, o.position)
            for o in options
        ],
        created_at=row.created_at,
        voting_opened_at=row.voting_opened_at,
        revealed_at=row.revealed_at,
        closed_at=row.closed_at,
        result=_result(row),
        rating=rating,
    )


# Readers asking for `tonight` must also get stored `revealed` rows that have settled.
_STORED_AS = {"tonight": ("revealed", "tonight")}


async def history(
    db: AsyncSession, household_id: uuid.UUID, statuses: list[str], limit: int
) -> list[NightSummary]:
    """Nights newest first, with the winner, the date and how many people voted. Filtered
    on the status readers see, so a settled reveal counts as `tonight`."""
    stored = sorted({s for want in statuses for s in _STORED_AS.get(want, (want,))})
    rows = await db.execute(
        text(
            """
            SELECT s.id, s.title, s.status, s.created_at, s.revealed_at, s.closed_at,
                   s.winner_option_id, o.movie_id, m.title AS movie_title, m.year,
                   m.poster_path,
                   (SELECT count(DISTINCT br.person_id) FROM ballot_ranks br
                     WHERE br.session_id = s.id) AS turnout,
                   (SELECT avg(r.score) FROM ratings r WHERE r.session_id = s.id)
                     AS rating_average,
                   (SELECT count(*) FROM ratings r WHERE r.session_id = s.id) AS rating_count
            FROM sessions s
            LEFT JOIN options o ON o.id = s.winner_option_id AND o.session_id = s.id
            LEFT JOIN movies m ON m.id = o.movie_id AND m.household_id = o.household_id
            WHERE s.household_id = :h AND s.status = ANY(:stored)
            ORDER BY coalesce(s.revealed_at, s.created_at) DESC, s.id
            """
        ),
        {"h": household_id, "stored": stored},
    )
    now = datetime.now(UTC)
    nights: list[NightSummary] = []
    for r in rows:
        status = session_state.effective_status(r.status, r.revealed_at, now)
        if status not in statuses:
            continue
        winner = None
        if r.winner_option_id is not None and session_state.shows_result(r.status):
            winner = Winner(r.winner_option_id, r.movie_id, r.movie_title, r.year, r.poster_path)
        rating = None
        if session_state.shows_rating(status):
            average = None if r.rating_average is None else float(r.rating_average)
            rating = RatingAverage(average, int(r.rating_count))
        nights.append(
            NightSummary(
                r.id,
                r.title,
                status,
                r.created_at,
                r.revealed_at,
                r.closed_at,
                winner,
                r.turnout,
                rating,
            )
        )
        if len(nights) == limit:
            break
    return nights
