"""Thanksgiving Scattergories (ADR-0018 section 4, 03-backend.md "Games").

A game holds rounds. The host starts a round (a random letter, N categories the host may have
edited, a duration); the server stores `ends_at` and is the clock. A round's *effective* state
is derived from `ends_at` on read (`running` -> `closed`), so no timer job exists and no tick
event is published: the snapshot carries `ends_at` and `server_now` and clients count down
locally. Players submit or replace answers until `ends_at` plus a 2-second grace.

Answers are visible to nobody, the host included, until the host reveals. Reveal freezes them.
Scores are derived on read by the pure `scatter.score_round` rules and never stored, so a host
verdict can never leave a stale score. Reading, hosting and the snapshot share the pure module;
the service only moves rows.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.games import scatter
from app.domain.games.scatter_categories import CATEGORIES
from app.realtime import events
from app.realtime.publisher import publish_game_after_commit
from app.services import consent_service, people_service
from app.services.errors import Conflict, Invalid, NotFound
from app.services.games_service import GameRow, _audit, _load

GRACE = timedelta(seconds=2)
MAX_CATEGORIES = 12
MAX_CATEGORY_LENGTH = 60
MAX_ANSWER_LENGTH = 60


@dataclass(frozen=True)
class Player:
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    answered: int


@dataclass(frozen=True)
class RoundView:
    round_no: int
    letter: str
    categories: list[str]
    duration_seconds: int
    ends_at: datetime
    state: str


@dataclass(frozen=True)
class AnswerView:
    answer_id: uuid.UUID
    person_id: uuid.UUID
    category_index: int
    text: str
    valid: bool
    point: int
    verdict: str | None


@dataclass(frozen=True)
class RevealedRound:
    round_no: int
    letter: str
    categories: list[str]
    answers: list[AnswerView]
    scores: dict[uuid.UUID, int]


@dataclass(frozen=True)
class Standing:
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    points: int


@dataclass(frozen=True)
class ScatterState:
    server_now: datetime
    current: RoundView | None
    players: list[Player]
    revealed: list[RevealedRound]
    leaderboard: list[Standing]


@dataclass(frozen=True)
class OwnAnswer:
    person_id: uuid.UUID
    round_no: int
    category_index: int
    text: str


def effective_state(revealed_at: datetime | None, ends_at: datetime, now: datetime) -> str:
    """`revealed`, else `running` until `ends_at`, then `closed`."""
    if revealed_at is not None:
        return "revealed"
    return "running" if now < ends_at else "closed"


def _require_scatter(game: GameRow) -> None:
    if game.kind != "scattergories":
        raise NotFound("Game not found")


async def _now(db: AsyncSession) -> datetime:
    now = await db.scalar(text("SELECT now()"))
    assert isinstance(now, datetime)
    return now


def clean_categories(raw: list[str]) -> list[str]:
    """Trim, collapse spaces, drop blanks and case-insensitive repeats; keeps host order."""
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        clean = " ".join(item.split())
        if not clean:
            continue
        if len(clean) > MAX_CATEGORY_LENGTH:
            raise Invalid(f"Keep each category under {MAX_CATEGORY_LENGTH} characters.")
        if clean.casefold() not in seen:
            seen.add(clean.casefold())
            out.append(clean)
    if not 1 <= len(out) <= MAX_CATEGORIES:
        raise Invalid(f"Pick between 1 and {MAX_CATEGORIES} categories.")
    return out


async def draw_categories(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID, *, count: int, seed: int
) -> list[str]:
    """A themed draw the host can edit before starting; nothing is stored."""
    _require_scatter(await _load(db, household_id, game_id))
    return scatter.draw_categories(CATEGORIES, random.Random(seed), min(count, MAX_CATEGORIES))


async def join(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
) -> None:
    """Idempotent: a person joins once."""
    game = await _load(db, household_id, game_id, lock="SHARE")
    _require_scatter(game)
    await consent_service.require_household_consent(db)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status == "ended":
        raise Conflict("The game is over.")
    inserted = await db.scalar(
        text(
            "INSERT INTO game_players (household_id, game_id, person_id) "
            "VALUES (:h, :g, :p) ON CONFLICT (game_id, person_id) DO NOTHING RETURNING id"
        ),
        {"h": household_id, "g": game_id, "p": person_id},
    )
    if inserted is not None:
        publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def _latest_round(db: AsyncSession, game_id: uuid.UUID, *, lock: bool = False) -> Any:
    suffix = " FOR UPDATE" if lock else ""
    return (
        await db.execute(
            text(
                "SELECT id, round_no, letter, categories, duration_seconds, ends_at, revealed_at "
                "FROM scatter_rounds WHERE game_id = :g ORDER BY round_no DESC LIMIT 1" + suffix
            ),
            {"g": game_id},
        )
    ).first()


async def start_round(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    seed: int,
    categories: list[str] | None,
    count: int,
    duration_seconds: int,
) -> None:
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_scatter(game)
    if game.status == "ended":
        raise Conflict("The game is over.")
    last = await _latest_round(db, game_id)
    if last is not None and last.revealed_at is None:
        raise Conflict("Reveal this round before starting the next.")
    if not 10 <= duration_seconds <= 900:
        raise Invalid("A round runs between 10 seconds and 15 minutes.")
    rng = random.Random(seed)
    if categories is None:
        chosen = scatter.draw_categories(CATEGORIES, rng, min(count, MAX_CATEGORIES))
    else:
        chosen = clean_categories(categories)
    letter = scatter.draw_letter(rng)
    round_no = 1 if last is None else last.round_no + 1
    await db.execute(
        text(
            "INSERT INTO scatter_rounds (household_id, game_id, round_no, letter, categories, "
            "duration_seconds, started_at, ends_at) VALUES (:h, :g, :n, :letter, :cats, "
            "CAST(:d AS integer), now(), now() + make_interval(secs => CAST(:d AS integer)))"
        ).bindparams(bindparam("cats", type_=JSONB)),
        {
            "h": household_id,
            "g": game_id,
            "n": round_no,
            "letter": letter,
            "cats": chosen,
            "d": duration_seconds,
        },
    )
    await db.execute(
        text(
            "UPDATE games SET status = 'live', started_at = coalesce(started_at, now()) "
            "WHERE id = :g"
        ),
        {"g": game_id},
    )
    await _audit(
        db, household_id, account_id, "game.round_started", game_id, {"round_no": round_no}
    )
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def submit(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    answers: list[tuple[int, str]],
) -> list[OwnAnswer]:
    """Save or replace answers until `ends_at` plus the grace. A blank answer clears it."""
    game = await _load(db, household_id, game_id, lock="SHARE")
    _require_scatter(game)
    await consent_service.require_household_consent(db)
    await people_service.require_can_act_as(db, device_id, person_id)
    on_roster = await db.scalar(
        text("SELECT 1 FROM game_players WHERE game_id = :g AND person_id = :p"),
        {"g": game_id, "p": person_id},
    )
    if on_roster is None:
        raise Conflict("Join the game first.")
    current = await _latest_round(db, game_id)
    now = await _now(db)
    if current is None or current.revealed_at is not None:
        raise Conflict("There's no round running.")
    if now > current.ends_at + GRACE:
        raise Conflict("Time's up.")
    seen: set[int] = set()
    cleaned: list[tuple[int, str]] = []
    for index, raw in answers:
        if not 0 <= index < len(current.categories):
            raise Invalid("No such category.")
        if index in seen:
            raise Invalid("One answer per category.")
        seen.add(index)
        clean = " ".join(raw.split())
        if len(clean) > MAX_ANSWER_LENGTH:
            raise Invalid(f"Keep answers under {MAX_ANSWER_LENGTH} characters.")
        cleaned.append((index, clean))
    for index, clean in cleaned:
        params = {
            "h": household_id,
            "r": current.id,
            "p": person_id,
            "i": index,
            "t": clean,
        }
        if clean:
            await db.execute(
                text(
                    "INSERT INTO scatter_answers (household_id, round_id, person_id, "
                    "category_index, text) VALUES (:h, :r, :p, :i, :t) "
                    "ON CONFLICT (round_id, person_id, category_index) "
                    "DO UPDATE SET text = EXCLUDED.text, updated_at = now()"
                ),
                params,
            )
        else:
            await db.execute(
                text(
                    "DELETE FROM scatter_answers WHERE round_id = :r AND person_id = :p "
                    "AND category_index = :i"
                ),
                params,
            )
    publish_game_after_commit(db, game_id, events.GAME_ACTIVITY)
    return await _own_in_round(db, current.id, current.round_no, [person_id])


async def _own_in_round(
    db: AsyncSession, round_id: uuid.UUID, round_no: int, people: list[uuid.UUID]
) -> list[OwnAnswer]:
    rows = await db.execute(
        text(
            "SELECT person_id, category_index, text FROM scatter_answers "
            "WHERE round_id = :r AND person_id = ANY(:ps) ORDER BY person_id, category_index"
        ),
        {"r": round_id, "ps": people},
    )
    return [OwnAnswer(r.person_id, round_no, r.category_index, r.text) for r in rows]


async def own_answers(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID, device_id: uuid.UUID
) -> list[OwnAnswer]:
    """The latest round's answers written by the people actively bound to this phone."""
    _require_scatter(await _load(db, household_id, game_id))
    current = await _latest_round(db, game_id)
    if current is None:
        return []
    people = [
        r.person_id
        for r in await db.execute(
            text("SELECT person_id FROM device_people WHERE device_id = :d AND status = 'active'"),
            {"d": device_id},
        )
    ]
    return await _own_in_round(db, current.id, current.round_no, people)


async def reveal(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    """Show every answer and freeze them. Revealing before time is up ends the round early."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_scatter(game)
    current = await _latest_round(db, game_id, lock=True)
    if current is None or current.revealed_at is not None:
        raise Conflict("There's no round to reveal.")
    await db.execute(
        text(
            "UPDATE scatter_rounds SET revealed_at = now(), ends_at = least(ends_at, now()) "
            "WHERE id = :r"
        ),
        {"r": current.id},
    )
    await _audit(
        db, household_id, account_id, "game.round_revealed", game_id, {"round_no": current.round_no}
    )
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def set_verdict(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    answer_id: uuid.UUID,
    verdict: str | None,
) -> None:
    """The host's reject / re-accept, only on a revealed round (the whole challenge step)."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_scatter(game)
    row = (
        await db.execute(
            text(
                "SELECT a.id, r.revealed_at FROM scatter_answers a "
                "JOIN scatter_rounds r ON r.id = a.round_id "
                "WHERE a.id = :a AND r.game_id = :g FOR UPDATE OF a"
            ),
            {"a": answer_id, "g": game_id},
        )
    ).first()
    if row is None:
        raise NotFound("Answer not found")
    if row.revealed_at is None:
        raise Conflict("Reveal the round first.")
    await db.execute(
        text("UPDATE scatter_answers SET host_verdict = :v WHERE id = :a"),
        {"v": verdict, "a": answer_id},
    )
    await _audit(
        db,
        household_id,
        account_id,
        "game.answer_verdict",
        game_id,
        {"answer_id": str(answer_id), "verdict": verdict},
    )
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def state(db: AsyncSession, game_id: uuid.UUID) -> ScatterState:
    """The snapshot's scattergories part. Answers appear only for revealed rounds; scores are
    derived here from the pure rules on every read."""
    now = await _now(db)
    rounds = list(
        await db.execute(
            text(
                "SELECT id, round_no, letter, categories, duration_seconds, ends_at, revealed_at "
                "FROM scatter_rounds WHERE game_id = :g ORDER BY round_no"
            ),
            {"g": game_id},
        )
    )
    roster = list(
        await db.execute(
            text(
                "SELECT p.id, p.name, p.avatar_emoji, p.color FROM game_players gp "
                "JOIN people p ON p.id = gp.person_id AND p.household_id = gp.household_id "
                "WHERE gp.game_id = :g ORDER BY gp.joined_at, p.id"
            ),
            {"g": game_id},
        )
    )
    last = rounds[-1] if rounds else None
    answered: dict[uuid.UUID, int] = {}
    if last is not None:
        for r in await db.execute(
            text(
                "SELECT person_id, count(*) AS n FROM scatter_answers "
                "WHERE round_id = :r GROUP BY person_id"
            ),
            {"r": last.id},
        ):
            answered[r.person_id] = r.n
    revealed: list[RevealedRound] = []
    totals: dict[uuid.UUID, int] = {p.id: 0 for p in roster}
    for rnd in rounds:
        if rnd.revealed_at is None:
            continue
        rows = list(
            await db.execute(
                text(
                    "SELECT id, person_id, category_index, text, host_verdict "
                    "FROM scatter_answers WHERE round_id = :r "
                    "ORDER BY category_index, created_at, id"
                ),
                {"r": rnd.id},
            )
        )
        pairs = [(str(r.person_id), r.category_index, r.text) for r in rows]
        verdicts = {(str(r.person_id), r.category_index): r.host_verdict for r in rows}
        points = scatter.answer_points(pairs, verdicts, letter=rnd.letter)
        totals_round = scatter.score_round(pairs, verdicts, letter=rnd.letter)
        answers = [
            AnswerView(
                r.id,
                r.person_id,
                r.category_index,
                r.text,
                scatter.is_valid(r.text, rnd.letter, r.host_verdict),
                points[(str(r.person_id), r.category_index)],
                r.host_verdict,
            )
            for r in rows
        ]
        scores = {uuid.UUID(pid): pts for pid, pts in totals_round.items()}
        for pid, pts in scores.items():
            totals[pid] = totals.get(pid, 0) + pts
        revealed.append(
            RevealedRound(rnd.round_no, rnd.letter, list(rnd.categories), answers, scores)
        )
    leaderboard = sorted(
        (Standing(p.id, p.name, p.avatar_emoji, p.color, totals.get(p.id, 0)) for p in roster),
        key=lambda s: (-s.points, s.name.casefold(), str(s.person_id)),
    )
    return ScatterState(
        server_now=now,
        current=None
        if last is None
        else RoundView(
            last.round_no,
            last.letter,
            list(last.categories),
            last.duration_seconds,
            last.ends_at,
            effective_state(last.revealed_at, last.ends_at, now),
        ),
        players=[
            Player(p.id, p.name, p.avatar_emoji, p.color, answered.get(p.id, 0)) for p in roster
        ],
        revealed=revealed,
        leaderboard=leaderboard,
    )
