"""Loteria (ADR-0018 amendment 2026-11-26). Cards live in `bingo_cards` (16 squares), calls in
`bingo_calls` (value = deck card id 1-54).

The host opens (which fixes the draw seed), starts, draws the next card and checks a spoken
"Loteria!"; a player joins (gets a tabla), rerolls it while the game is `open`, and marks a
picture that has been called. A check reads the CALLED set, never the taps. The seed and any
future call never leave the server.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.games import loteria
from app.domain.games.loteria_deck import BY_ID
from app.realtime import events
from app.realtime.publisher import publish_game_after_commit
from app.services import consent_service, people_service
from app.services.errors import Conflict, Invalid, NotFound
from app.services.games_service import GameRow, _audit, _load


@dataclass(frozen=True)
class Call:
    seq: int
    card_id: int
    name_es: str
    name_en: str
    emoji: str


@dataclass(frozen=True)
class Player:
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    missing: int
    won: bool
    finish_place: int | None


@dataclass(frozen=True)
class State:
    pattern: str
    end_on_first_win: bool
    calls: list[Call]
    players: list[Player]


@dataclass(frozen=True)
class Tabla:
    person_id: uuid.UUID
    squares: list[int]
    marked: list[int]
    missing: int
    won: bool
    finish_place: int | None


@dataclass(frozen=True)
class Check:
    valid: bool
    pattern: str
    squares: list[int] | None
    missing: int


def require_loteria(game: GameRow) -> None:
    if game.kind != "loteria":
        raise NotFound("Game not found")


def pattern_of(game: GameRow) -> str:
    p = game.config.get("pattern")
    return p if p in loteria.PATTERNS else "line"


def _call(seq: int, card_id: int) -> Call:
    c = BY_ID[card_id]
    return Call(seq, c.id, c.name_es, c.name_en, c.emoji)


async def _calls(db: AsyncSession, game_id: uuid.UUID) -> list[Call]:
    rows = await db.execute(
        text("SELECT seq, value FROM bingo_calls WHERE game_id = :g ORDER BY seq"), {"g": game_id}
    )
    return [_call(r.seq, r.value) for r in rows]


async def _called_set(db: AsyncSession, game_id: uuid.UUID) -> set[int]:
    return {c.card_id for c in await _calls(db, game_id)}


async def _places(db: AsyncSession, game_id: uuid.UUID) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        text(
            "SELECT person_id FROM bingo_cards WHERE game_id = :g AND won_at IS NOT NULL "
            "ORDER BY won_at, id"
        ),
        {"g": game_id},
    )
    return {r.person_id: i for i, r in enumerate(rows, start=1)}


def _marked(mask: int) -> list[int]:
    return [i for i in range(loteria.CELLS) if mask >> i & 1]


def _missing(game: GameRow, squares: list[str], called: set[int]) -> int:
    return loteria.missing(loteria.called_mask(squares, called), pattern_of(game))


async def state(db: AsyncSession, game: GameRow) -> State:
    """Who is playing and how close each tabla is, and the cards called so far. Never a
    tabla, a mark, the seed or a card not yet called."""
    calls = await _calls(db, game.id)
    called = {c.card_id for c in calls}
    places = await _places(db, game.id)
    rows = await db.execute(
        text(
            """
            SELECT p.id, p.name, p.avatar_emoji, p.color, c.squares, c.won_at
            FROM bingo_cards c
            JOIN people p ON p.id = c.person_id AND p.household_id = c.household_id
            WHERE c.game_id = :g
            ORDER BY c.created_at, c.id
            """
        ),
        {"g": game.id},
    )
    return State(
        pattern=pattern_of(game),
        end_on_first_win=bool(game.config.get("end_on_first_win", True)),
        calls=calls,
        players=[
            Player(
                r.id,
                r.name,
                r.avatar_emoji,
                r.color,
                _missing(game, list(r.squares), called),
                r.won_at is not None,
                places.get(r.id),
            )
            for r in rows
        ],
    )


def _tabla(row: Any, game: GameRow, places: dict[uuid.UUID, int], called: set[int]) -> Tabla:
    squares = list(row.squares)
    return Tabla(
        person_id=row.person_id,
        squares=[int(s) for s in squares],
        marked=_marked(row.marked_mask),
        missing=_missing(game, squares, called),
        won=row.won_at is not None,
        finish_place=places.get(row.person_id),
    )


_CARD = text(
    "SELECT person_id, squares, marked_mask, won_at FROM bingo_cards "
    "WHERE game_id = :g AND person_id = :p"
)


async def open_game(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    seed: int,
) -> None:
    """draft -> open: the family can join and reroll. Fixes the draw seed. Idempotent."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    require_loteria(game)
    if game.status == "open":
        return
    if game.status != "draft":
        raise Conflict("That round has already started.")
    await db.execute(
        text(
            "UPDATE games SET status = 'open', started_at = now(), "
            "reveal_seed = COALESCE(reveal_seed, :seed) WHERE id = :g"
        ),
        {"g": game_id, "seed": seed},
    )
    await _audit(db, household_id, account_id, "game.opened", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def start_round(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    """open -> live: drawing and marking start; rerolling stops."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    require_loteria(game)
    if game.status == "live":
        raise Conflict("The round has already started.")
    if game.status != "open":
        raise Conflict("Open the game for players first." if game.status == "draft" else "Over.")
    await db.execute(text("UPDATE games SET status = 'live' WHERE id = :g"), {"g": game_id})
    await _audit(db, household_id, account_id, "game.started", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def join(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    seed: int,
) -> Tabla:
    """Take a seat and get a tabla. Idempotent: joining again returns the same tabla."""
    game = await _load(db, household_id, game_id, lock="SHARE")
    require_loteria(game)
    await consent_service.require_household_consent(db)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status == "draft":
        raise Conflict("The game isn't open for players yet.")
    if game.status == "ended":
        raise Conflict("The round is over.")
    squares = loteria.generate_tabla(random.Random(seed ^ person_id.int))
    created = await db.scalar(
        text(
            "INSERT INTO bingo_cards (household_id, game_id, person_id, squares, marked_mask) "
            "VALUES (:h, :g, :p, :squares, 0) "
            "ON CONFLICT (game_id, person_id) DO NOTHING RETURNING id"
        ),
        {"h": household_id, "g": game_id, "p": person_id, "squares": squares},
    )
    await db.execute(
        text(
            "INSERT INTO game_players (household_id, game_id, person_id) VALUES (:h, :g, :p) "
            "ON CONFLICT (game_id, person_id) DO NOTHING"
        ),
        {"h": household_id, "g": game_id, "p": person_id},
    )
    if created is not None:
        publish_game_after_commit(db, game_id, events.GAME_CHANGED)
    row = (await db.execute(_CARD, {"g": game_id, "p": person_id})).one()
    return _tabla(row, game, await _places(db, game_id), await _called_set(db, game_id))


async def reroll(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    seed: int,
) -> Tabla:
    """Swap your tabla for a new one: unlimited while the game is `open`, 409 once `live`."""
    game = await _load(db, household_id, game_id, lock="SHARE")
    require_loteria(game)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status != "open":
        raise Conflict(
            "The game isn't open for players yet."
            if game.status == "draft"
            else "The round has started, so your tabla is fixed."
        )
    row = (
        await db.execute(text(str(_CARD) + " FOR UPDATE"), {"g": game_id, "p": person_id})
    ).first()
    if row is None:
        raise NotFound("You haven't joined this game.")
    squares = loteria.generate_tabla(random.Random(seed ^ person_id.int))
    if squares == list(row.squares):  # a reroll must change something
        squares = loteria.generate_tabla(random.Random(~seed ^ person_id.int))
    await db.execute(
        text(
            "UPDATE bingo_cards SET squares = :s, marked_mask = 0 "
            "WHERE game_id = :g AND person_id = :p"
        ),
        {"s": squares, "g": game_id, "p": person_id},
    )
    publish_game_after_commit(db, game_id, events.GAME_ACTIVITY)
    fresh = (await db.execute(_CARD, {"g": game_id, "p": person_id})).one()
    return _tabla(fresh, game, await _places(db, game_id), set())


async def my_tablas(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID, device_id: uuid.UUID
) -> list[Tabla]:
    """Tablas of the people actively bound to this phone, and nobody else's."""
    game = await _load(db, household_id, game_id)
    require_loteria(game)
    rows = await db.execute(
        text(
            """
            SELECT c.person_id, c.squares, c.marked_mask, c.won_at
            FROM bingo_cards c
            JOIN device_people dp ON dp.person_id = c.person_id AND dp.device_id = :d
                                  AND dp.status = 'active'
            WHERE c.game_id = :g
            ORDER BY c.created_at, c.id
            """
        ),
        {"d": device_id, "g": game_id},
    )
    places = await _places(db, game_id)
    called = await _called_set(db, game_id)
    return [_tabla(r, game, places, called) for r in rows]


async def set_mark(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    index: int,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    marked: bool,
) -> Tabla:
    """Mark or unmark one picture on your own tabla. Idempotent. Only a called card can be
    marked (409); marking never wins, only a host check does."""
    if not 0 <= index < loteria.CELLS:
        raise Invalid("No such square.")
    game = await _load(db, household_id, game_id, lock="UPDATE")
    require_loteria(game)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status == "ended":
        raise Conflict("The round is over.")
    if game.status != "live":
        raise Conflict("The round hasn't started.")
    row = (
        await db.execute(text(str(_CARD) + " FOR UPDATE"), {"g": game_id, "p": person_id})
    ).first()
    if row is None:
        raise NotFound("You haven't joined this game.")
    called = await _called_set(db, game_id)
    mask = row.marked_mask
    if bool(mask >> index & 1) != marked:
        if marked and not loteria.is_called(row.squares[index], called):
            raise Conflict("That card hasn't been called.")
        mask = loteria.toggle(mask, index)
        await db.execute(
            text("UPDATE bingo_cards SET marked_mask = :m WHERE game_id = :g AND person_id = :p"),
            {"m": mask, "g": game_id, "p": person_id},
        )
        publish_game_after_commit(db, game_id, events.GAME_ACTIVITY)
    fresh = (await db.execute(_CARD, {"g": game_id, "p": person_id})).one()
    return _tabla(fresh, game, await _places(db, game_id), called)


async def draw(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    expected_seq: int,
) -> Call:
    """Call the next card. `expected_seq` is how many calls the host's screen showed; a
    different count (double tap, second host window) is 409 and inserts nothing."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    require_loteria(game)
    if game.status != "live":
        raise Conflict("Start the round first." if game.status in ("draft", "open") else "Over.")
    count = await db.scalar(
        text("SELECT count(*) FROM bingo_calls WHERE game_id = :g"), {"g": game_id}
    )
    if count != expected_seq:
        raise Conflict("The board moved on. Check the last card and try again.")
    if count >= loteria.DECK_SIZE:
        raise Conflict("Every card has been called.")
    seed = await db.scalar(text("SELECT reveal_seed FROM games WHERE id = :g"), {"g": game_id})
    if seed is None:
        raise Conflict("This game has no draw seed.")
    value = loteria.call_order(int(seed))[count]
    await db.execute(
        text("INSERT INTO bingo_calls (household_id, game_id, seq, value) VALUES (:h, :g, :s, :v)"),
        {"h": household_id, "g": game_id, "s": count, "v": value},
    )
    await _audit(
        db, household_id, account_id, "game.loteria_called", game_id, {"seq": count, "card": value}
    )
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)
    return _call(count, value)


async def check(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    person_id: uuid.UUID,
) -> Check:
    """Verify a spoken "Loteria!" against the called cards (not the taps). A false claim
    leaves the game running and sends no event; a true one records the win and, with
    `end_on_first_win`, ends the game in the same transaction."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    require_loteria(game)
    if game.status != "live":
        raise Conflict("The round isn't running.")
    row = (
        await db.execute(
            text(
                "SELECT squares, won_at FROM bingo_cards WHERE game_id = :g AND person_id = :p "
                "FOR UPDATE"
            ),
            {"g": game_id, "p": person_id},
        )
    ).first()
    if row is None:
        raise NotFound("That player has no tabla.")
    mode = pattern_of(game)
    mask = loteria.called_mask(list(row.squares), await _called_set(db, game_id))
    won = loteria.pattern(mask, mode)
    valid = won is not None
    result = Check(valid, mode, won, loteria.missing(mask, mode))
    await _audit(
        db,
        household_id,
        account_id,
        "game.loteria_checked",
        game_id,
        {"person_id": str(person_id), "valid": valid},
    )
    if valid and row.won_at is None:
        await db.execute(
            text(
                "UPDATE bingo_cards SET won_at = clock_timestamp() "
                "WHERE game_id = :g AND person_id = :p"
            ),
            {"g": game_id, "p": person_id},
        )
        if game.config.get("end_on_first_win", True):
            await db.execute(
                text("UPDATE games SET status = 'ended', ended_at = now() WHERE id = :g"),
                {"g": game_id},
            )
            await _audit(db, household_id, account_id, "game.ended", game_id)
        publish_game_after_commit(db, game_id, events.GAME_CHANGED)
    return result
