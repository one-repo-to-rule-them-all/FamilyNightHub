"""Games and the Gratitude Jar (ADR-0018, 03-backend.md "Games").

A game is household-scoped and not tied to a night. Hosts (`sessions:run`) create, start the
reveal, show the next note, hide a note and end; players act as a person bound to their phone
(`people_service.require_can_act_as`, like a ballot). Notes store a child's words, so adding
one passes the consent gate (ADR-0017).

Unrevealed note text leaves the server only to its author and to the host's moderation
list; an anonymous note never exposes its author to anyone. Every transition writes an audit
row and queues a hint on `game:{id}` for after the commit (events are hints, ADR-0004).
"""

from __future__ import annotations

import random
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.games import bingo, bingo_classic, bingo_pool, jar
from app.realtime import events
from app.realtime.publisher import publish_game_after_commit
from app.services import consent_service, people_service
from app.services.errors import Conflict, Invalid, NotFound

_AUDIT = text(
    "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
    "target_id, data) VALUES (:h, :a, :action, 'game', :t, :data)"
).bindparams(bindparam("data", type_=JSONB))

# The jar (A), bingo (B) and scattergories (C).
AVAILABLE_KINDS = frozenset({"gratitude_jar", "bingo", "scattergories", "loteria"})
LOTERIA_PATTERNS = frozenset({"line", "corners", "center", "full"})
WIN_MODES = frozenset({"line", "blackout"})
BINGO_MODES = frozenset({"thanksgiving", "classic"})


@dataclass(frozen=True)
class GameRow:
    id: uuid.UUID
    kind: str
    title: str
    status: str
    created_at: datetime
    config: dict[str, Any]


@dataclass(frozen=True)
class Author:
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str


@dataclass(frozen=True)
class ShownNote:
    id: uuid.UUID
    body: str
    author: Author | None
    revealed_at: datetime


@dataclass(frozen=True)
class JarCycle:
    anchor_at: datetime
    server_now: datetime
    dwell_seconds: int
    paused_index: int | None


@dataclass(frozen=True)
class JarState:
    note_count: int
    revealed_count: int
    remaining: int
    current: ShownNote | None
    revealed: list[ShownNote]
    mode: str = "manual"
    cycle: JarCycle | None = None


@dataclass(frozen=True)
class BingoPlayer:
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    squares_from_bingo: int
    won: bool
    # 1 for the first card to finish, 2 for the next; None until the card wins.
    finish_place: int | None


@dataclass(frozen=True)
class BingoCall:
    seq: int
    value: int
    label: str


@dataclass(frozen=True)
class BingoCheck:
    valid: bool
    win_mode: str
    pattern: list[int] | None
    missing: int


@dataclass(frozen=True)
class BingoState:
    mode: str
    calls: list[BingoCall]
    win_mode: str
    free_center: bool
    end_on_first_win: bool
    players: list[BingoPlayer]


@dataclass(frozen=True)
class OwnCard:
    person_id: uuid.UUID
    squares: list[str]
    marked: list[int]
    squares_from_bingo: int
    won: bool
    finish_place: int | None


@dataclass(frozen=True)
class OwnNote:
    id: uuid.UUID
    person_id: uuid.UUID
    body: str
    anonymous: bool
    revealed: bool


@dataclass(frozen=True)
class ModerationNote:
    id: uuid.UUID
    body: str
    anonymous: bool
    author: Author | None
    revealed_at: datetime | None
    hidden_at: datetime | None


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    game_id: uuid.UUID,
    data: dict[str, Any] | None = None,
) -> None:
    await db.execute(
        _AUDIT,
        {"h": household_id, "a": account_id, "action": action, "t": game_id, "data": data or {}},
    )


def _game(row: Any) -> GameRow:
    return GameRow(row.id, row.kind, row.title, row.status, row.created_at, row.config or {})


async def _load(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID, *, lock: str | None = None
) -> GameRow:
    """The game, or NotFound (other household or unknown). `lock` is `UPDATE` or `SHARE`:
    host transitions take UPDATE, a dropped note SHARE, so they serialize."""
    suffix = f" FOR {lock}" if lock else ""
    row = (
        await db.execute(
            text(
                "SELECT id, kind, title, status, created_at, config FROM games "
                f"WHERE id = :g AND household_id = :h{suffix}"
            ),
            {"g": game_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound("Game not found")
    return _game(row)


async def list_games(db: AsyncSession, household_id: uuid.UUID) -> list[GameRow]:
    rows = await db.execute(
        text(
            "SELECT id, kind, title, status, created_at, config FROM games "
            "WHERE household_id = :h ORDER BY created_at DESC, id"
        ),
        {"h": household_id},
    )
    return [_game(r) for r in rows]


async def create_game(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    kind: str,
    title: str,
    allow_anonymous: bool,
    win_mode: str = "line",
    free_center: bool = True,
    end_on_first_win: bool = True,
    mode: str = "thanksgiving",
    reveal_mode: str = "cycle",
    cycle_seconds: int = jar.CYCLE_SECONDS_DEFAULT,
    pattern: str = "line",
) -> GameRow:
    if kind not in AVAILABLE_KINDS:
        raise Invalid("That game isn't available yet.")
    if kind == "bingo":
        if win_mode not in WIN_MODES:
            raise Invalid("Pick line or blackout.")
        if mode not in BINGO_MODES:
            raise Invalid("Pick classic or Thanksgiving bingo.")
        config: dict[str, Any] = {
            "mode": mode,
            "win_mode": win_mode,
            "free_center": free_center,
            "end_on_first_win": end_on_first_win,
        }
        status = "draft"  # the host opens it when the family is ready to join
    elif kind == "loteria":
        if pattern not in LOTERIA_PATTERNS:
            raise Invalid("Pick line, four corners, centre four or full tabla.")
        config = {"pattern": pattern, "end_on_first_win": end_on_first_win}
        status = "draft"
    else:
        config = {"allow_anonymous": allow_anonymous}
        if kind == "gratitude_jar":
            if reveal_mode not in ("cycle", "manual"):
                raise Invalid("Pick cycle or manual.")
            if not jar.CYCLE_SECONDS_MIN <= cycle_seconds <= jar.CYCLE_SECONDS_MAX:
                raise Invalid(
                    f"Pick {jar.CYCLE_SECONDS_MIN} to {jar.CYCLE_SECONDS_MAX} seconds a note."
                )
            config["reveal_mode"] = reveal_mode
            config["cycle_seconds"] = cycle_seconds
        status = "open"
    clean = " ".join(title.split())
    if not clean:
        raise Invalid("Give the game a name.")
    row = (
        await db.execute(
            text(
                "INSERT INTO games (household_id, kind, title, status, config, "
                "created_by_account_id, started_at) "
                "VALUES (:h, :kind, :title, :status, :config, :a, "
                "CASE WHEN :is_open THEN now() END) "
                "RETURNING id, kind, title, status, created_at, config"
            ).bindparams(bindparam("config", type_=JSONB)),
            {
                "h": household_id,
                "kind": kind,
                "title": clean,
                "config": config,
                "status": status,
                "is_open": status == "open",
                "a": account_id,
            },
        )
    ).one()
    await _audit(db, household_id, account_id, "game.created", row.id, {"kind": kind})
    return _game(row)


async def _shown(db: AsyncSession, game_id: uuid.UUID) -> list[ShownNote]:
    """Revealed, not hidden notes in reveal order. Anonymous ones carry no author."""
    rows = await db.execute(
        text(
            """
            SELECT n.id, n.body, n.anonymous, n.revealed_at,
                   p.id AS pid, p.name, p.avatar_emoji, p.color
            FROM gratitude_notes n
            JOIN people p ON p.id = n.person_id AND p.household_id = n.household_id
            WHERE n.game_id = :g AND n.revealed_at IS NOT NULL AND n.hidden_at IS NULL
            ORDER BY n.reveal_position
            """
        ),
        {"g": game_id},
    )
    return [
        ShownNote(
            r.id,
            r.body,
            None if r.anonymous else Author(r.pid, r.name, r.avatar_emoji, r.color),
            r.revealed_at,
        )
        for r in rows
    ]


def jar_mode(game: GameRow) -> str:
    """A stored config with no `reveal_mode` is a manual jar (as built before the cycle)."""
    return "cycle" if game.config.get("reveal_mode") == "cycle" else "manual"


def _dwell(game: GameRow) -> int:
    raw = game.config.get("cycle_seconds", jar.CYCLE_SECONDS_DEFAULT)
    return raw if isinstance(raw, int) else jar.CYCLE_SECONDS_DEFAULT


async def jar_state(db: AsyncSession, game: GameRow) -> JarState:
    game_id = game.id
    shown = await _shown(db, game_id)
    counts = (
        await db.execute(
            text(
                "SELECT count(*) FILTER (WHERE hidden_at IS NULL) AS total, "
                "count(*) FILTER (WHERE hidden_at IS NULL AND revealed_at IS NOT NULL) AS done "
                "FROM gratitude_notes WHERE game_id = :g"
            ),
            {"g": game_id},
        )
    ).one()
    mode = jar_mode(game)
    cycle: JarCycle | None = None
    if mode == "cycle":
        row = (
            await db.execute(
                text(
                    "SELECT cycle_anchor_at, cycle_paused_index, clock_timestamp() AS server_now "
                    "FROM games WHERE id = :g"
                ),
                {"g": game_id},
            )
        ).one()
        if row.cycle_anchor_at is not None:
            cycle = JarCycle(
                row.cycle_anchor_at, row.server_now, _dwell(game), row.cycle_paused_index
            )
    return JarState(
        note_count=counts.total,
        revealed_count=counts.done,
        remaining=counts.total - counts.done,
        current=None if mode == "cycle" or not shown else shown[-1],
        revealed=shown,
        mode=mode,
        cycle=cycle,
    )


async def snapshot(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID
) -> tuple[GameRow, JarState | None, BingoState | None]:
    game = await _load(db, household_id, game_id)
    return (
        game,
        await jar_state(db, game) if game.kind == "gratitude_jar" else None,
        await bingo_state(db, game) if game.kind == "bingo" else None,
    )


def _require_jar(game: GameRow) -> None:
    if game.kind != "gratitude_jar":
        raise NotFound("Game not found")


async def add_note(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    body: str,
    anonymous: bool,
) -> OwnNote:
    game = await _load(db, household_id, game_id, lock="SHARE")
    _require_jar(game)
    await consent_service.require_household_consent(db)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status != "open":
        raise Conflict("The jar isn't taking notes any more.")
    if anonymous and not game.config.get("allow_anonymous", True):
        raise Invalid("This jar doesn't take anonymous notes.")
    clean = jar.clean_body(body)
    if not clean:
        raise Invalid("Write something first.")
    if len(clean) > jar.MAX_NOTE_LENGTH:
        raise Invalid(f"Keep it under {jar.MAX_NOTE_LENGTH} characters.")
    note_id = await db.scalar(
        text(
            "INSERT INTO gratitude_notes (household_id, game_id, person_id, body, anonymous) "
            "VALUES (:h, :g, :p, :body, :anon) RETURNING id"
        ),
        {"h": household_id, "g": game_id, "p": person_id, "body": clean, "anon": anonymous},
    )
    publish_game_after_commit(db, game_id, events.GAME_ACTIVITY)
    return OwnNote(note_id, person_id, clean, anonymous, False)


async def delete_own_note(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    note_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
) -> None:
    """An author takes their note back until it has been shown. Anyone else's note, or one
    already revealed, is 404 (so the endpoint can't probe who wrote what)."""
    await _load(db, household_id, game_id, lock="SHARE")
    row = (
        await db.execute(
            text(
                "SELECT person_id FROM gratitude_notes WHERE id = :n AND game_id = :g "
                "AND revealed_at IS NULL FOR UPDATE"
            ),
            {"n": note_id, "g": game_id},
        )
    ).first()
    if row is None or not await people_service.can_act_as(db, device_id, row.person_id):
        raise NotFound("Note not found")
    await db.execute(text("DELETE FROM gratitude_notes WHERE id = :n"), {"n": note_id})
    publish_game_after_commit(db, game_id, events.GAME_ACTIVITY)


async def own_notes(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID, device_id: uuid.UUID
) -> list[OwnNote]:
    """Notes written by the people actively bound to this phone."""
    await _load(db, household_id, game_id)
    rows = await db.execute(
        text(
            """
            SELECT n.id, n.person_id, n.body, n.anonymous, n.revealed_at IS NOT NULL AS revealed
            FROM gratitude_notes n
            JOIN device_people dp ON dp.person_id = n.person_id AND dp.device_id = :d
                                  AND dp.status = 'active'
            WHERE n.game_id = :g AND n.hidden_at IS NULL
            ORDER BY n.created_at, n.id
            """
        ),
        {"d": device_id, "g": game_id},
    )
    return [OwnNote(r.id, r.person_id, r.body, r.anonymous, r.revealed) for r in rows]


async def moderation(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID
) -> list[ModerationNote]:
    """Every note with its text, for the host. An anonymous note shows no author, even here."""
    game = await _load(db, household_id, game_id)
    _require_jar(game)
    rows = await db.execute(
        text(
            """
            SELECT n.id, n.body, n.anonymous, n.revealed_at, n.hidden_at,
                   p.id AS pid, p.name, p.avatar_emoji, p.color
            FROM gratitude_notes n
            JOIN people p ON p.id = n.person_id AND p.household_id = n.household_id
            WHERE n.game_id = :g
            ORDER BY n.created_at, n.id
            """
        ),
        {"g": game_id},
    )
    return [
        ModerationNote(
            r.id,
            r.body,
            r.anonymous,
            None if r.anonymous else Author(r.pid, r.name, r.avatar_emoji, r.color),
            r.revealed_at,
            r.hidden_at,
        )
        for r in rows
    ]


async def hide_note(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    note_id: uuid.UUID,
) -> None:
    """Hide a note from every screen. Idempotent; the row stays for the export."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_jar(game)
    changed = await db.scalar(
        text(
            "UPDATE gratitude_notes SET hidden_at = now() "
            "WHERE id = :n AND game_id = :g AND hidden_at IS NULL RETURNING id"
        ),
        {"n": note_id, "g": game_id},
    )
    if changed is None:
        exists = await db.scalar(
            text("SELECT 1 FROM gratitude_notes WHERE id = :n AND game_id = :g"),
            {"n": note_id, "g": game_id},
        )
        if exists is None:
            raise NotFound("Note not found")
        return
    await _audit(
        db, household_id, account_id, "game.note_hidden", game_id, {"note_id": str(note_id)}
    )
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def _reorder(db: AsyncSession, game_id: uuid.UUID, seed: int, *, only_revealed: bool) -> None:
    """Group similar notes and store the order. Positions are cleared first because
    (game_id, reveal_position) is unique."""
    rows = list(
        await db.execute(
            text(
                "SELECT id, body FROM gratitude_notes WHERE game_id = :g AND hidden_at IS NULL"
                + (" AND revealed_at IS NOT NULL" if only_revealed else "")
            ),
            {"g": game_id},
        )
    )
    await db.execute(
        text("UPDATE gratitude_notes SET reveal_position = NULL WHERE game_id = :g"),
        {"g": game_id},
    )
    for position, note_id in enumerate(jar.group_order([(r.id, r.body) for r in rows], seed)):
        await db.execute(
            text("UPDATE gratitude_notes SET reveal_position = :pos WHERE id = :n"),
            {"pos": position, "n": note_id},
        )


async def start_reveal(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    seed: int,
) -> None:
    """Close the jar to new notes and fix an order for the unhidden ones. A cycle jar also
    shows every one of them from now on and anchors the cycle clock."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_jar(game)
    if game.status == "live":
        raise Conflict("The reveal has already started.")
    if game.status != "open":
        raise Conflict("The jar is over.")
    cycling = jar_mode(game) == "cycle"
    ids = [
        r.id
        for r in await db.execute(
            text("SELECT id FROM gratitude_notes WHERE game_id = :g AND hidden_at IS NULL"),
            {"g": game_id},
        )
    ]
    if not ids:
        raise Conflict("Nothing in the jar yet.")
    if cycling:
        await _reorder(db, game_id, seed, only_revealed=False)
        await db.execute(
            text(
                "UPDATE gratitude_notes SET revealed_at = now() "
                "WHERE game_id = :g AND hidden_at IS NULL"
            ),
            {"g": game_id},
        )
    else:
        for position, note_id in enumerate(jar.reveal_order(ids, seed)):
            await db.execute(
                text("UPDATE gratitude_notes SET reveal_position = :pos WHERE id = :n"),
                {"pos": position, "n": note_id},
            )
    await db.execute(
        text(
            "UPDATE games SET status = 'live', reveal_seed = :seed, "
            "cycle_anchor_at = CASE WHEN :cycling THEN now() END, cycle_paused_index = NULL "
            "WHERE id = :g"
        ),
        {"seed": seed, "g": game_id, "cycling": cycling},
    )
    await _audit(db, household_id, account_id, "game.reveal_started", game_id, {"notes": len(ids)})
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def reveal_next(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_jar(game)
    if jar_mode(game) == "cycle":
        raise Conflict("This jar shows its notes by itself.")
    if game.status == "open":
        raise Conflict("Start the reveal first.")
    if game.status != "live":
        raise Conflict("The jar is over.")
    shown = await db.scalar(
        text(
            "UPDATE gratitude_notes SET revealed_at = now() WHERE id = ("
            "  SELECT id FROM gratitude_notes WHERE game_id = :g AND revealed_at IS NULL "
            "  AND hidden_at IS NULL AND reveal_position IS NOT NULL "
            "  ORDER BY reveal_position LIMIT 1) RETURNING id"
        ),
        {"g": game_id},
    )
    if shown is None:
        raise Conflict("That's every note.")
    await _audit(db, household_id, account_id, "game.note_revealed", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def _live_cycle(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID
) -> tuple[GameRow, Any]:
    """The locked cycling jar with its clock row, or Conflict."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_jar(game)
    if jar_mode(game) != "cycle":
        raise Conflict("This jar shows its notes one at a time.")
    if game.status != "live":
        raise Conflict("The jar hasn't started." if game.status == "open" else "The jar is over.")
    clock = (
        await db.execute(
            text(
                "SELECT extract(epoch FROM now())::float8 AS now_s, "
                "extract(epoch FROM cycle_anchor_at)::float8 AS anchor_s, "
                "cycle_paused_index, "
                "(SELECT count(*) FROM gratitude_notes WHERE game_id = :g "
                " AND hidden_at IS NULL AND revealed_at IS NOT NULL) AS shown "
                "FROM games WHERE id = :g"
            ),
            {"g": game_id},
        )
    ).one()
    return game, clock


async def pause_cycle(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    """Hold the note on show. Pausing a paused jar changes nothing."""
    game, clock = await _live_cycle(db, household_id, game_id)
    if not jar.can_pause(clock.cycle_paused_index):
        return
    index = jar.cycle_index(clock.now_s, clock.anchor_s, _dwell(game), clock.shown, None)
    await db.execute(
        text("UPDATE games SET cycle_paused_index = :i WHERE id = :g"), {"i": index, "g": game_id}
    )
    await _audit(db, household_id, account_id, "game.jar_paused", game_id, {"index": index})
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def resume_cycle(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    """Re-anchor so the held note gets a full dwell. Resuming a running jar changes nothing."""
    game, clock = await _live_cycle(db, household_id, game_id)
    if not jar.can_resume(clock.cycle_paused_index):
        return
    index = jar.cycle_index(0, 0, _dwell(game), clock.shown, clock.cycle_paused_index)
    await db.execute(
        text(
            "UPDATE games SET cycle_paused_index = NULL, "
            "cycle_anchor_at = now() - make_interval(secs => :s) WHERE id = :g"
        ),
        {"s": float(index * _dwell(game)), "g": game_id},
    )
    await _audit(db, household_id, account_id, "game.jar_resumed", game_id, {"index": index})
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def reshuffle_cycle(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    seed: int,
) -> None:
    """A new grouped order from the first note. A paused jar stays paused, on the first."""
    _game_row, clock = await _live_cycle(db, household_id, game_id)
    await _reorder(db, game_id, seed, only_revealed=True)
    paused = clock.cycle_paused_index is not None
    await db.execute(
        text(
            "UPDATE games SET reveal_seed = :seed, cycle_anchor_at = now(), "
            "cycle_paused_index = CASE WHEN :paused THEN 0 END WHERE id = :g"
        ),
        {"seed": seed, "paused": paused, "g": game_id},
    )
    await _audit(db, household_id, account_id, "game.jar_reshuffled", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def end_game(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    """Idempotent: ending an ended game changes nothing."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    if game.status == "ended":
        return
    await db.execute(
        text("UPDATE games SET status = 'ended', ended_at = now() WHERE id = :g"), {"g": game_id}
    )
    await _audit(db, household_id, account_id, "game.ended", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


# ---- The paired TV's target (ADR-0018 amendment) ----


async def tv_target(db: AsyncSession, household_id: uuid.UUID) -> uuid.UUID | None:
    """The game a host sent to the TV, or None. A game that has ended is no longer sent: the
    TV falls back on its own, so there is nothing to clean up (events stay hints)."""
    row = (
        await db.execute(
            text(
                "SELECT t.game_id FROM household_tv_target t "
                "JOIN games g ON g.id = t.game_id AND g.household_id = t.household_id "
                "WHERE t.household_id = :h AND g.status <> 'ended'"
            ),
            {"h": household_id},
        )
    ).first()
    return None if row is None else row.game_id


async def set_tv_target(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID | None,
) -> uuid.UUID | None:
    """Send a game to the TV, or (None) send the TV back to its home screen. Idempotent."""
    if game_id is None:
        await db.execute(
            text("DELETE FROM household_tv_target WHERE household_id = :h"), {"h": household_id}
        )
        return None
    game = await _load(db, household_id, game_id)
    if game.status == "ended":
        raise Conflict("That game has ended.")
    await db.execute(
        text(
            "INSERT INTO household_tv_target (household_id, game_id, set_by_account_id) "
            "VALUES (:h, :g, :a) ON CONFLICT (household_id) DO UPDATE "
            "SET game_id = EXCLUDED.game_id, set_by_account_id = EXCLUDED.set_by_account_id, "
            "updated_at = now()"
        ),
        {"h": household_id, "g": game_id, "a": account_id},
    )
    await _audit(db, household_id, account_id, "game.shown_on_tv", game_id)
    return game_id


# ---- Thanksgiving Bingo ----


def _require_bingo(game: GameRow) -> None:
    if game.kind != "bingo":
        raise NotFound("Game not found")


def _win_mode(game: GameRow) -> bingo.WinMode:
    return "blackout" if game.config.get("win_mode") == "blackout" else "line"


def _mode(game: GameRow) -> str:
    """A stored config with no `mode` is a Thanksgiving round."""
    return "classic" if game.config.get("mode") == "classic" else "thanksgiving"


def _require_classic(game: GameRow) -> None:
    _require_bingo(game)
    if _mode(game) != "classic":
        raise Conflict("This is a Thanksgiving round.")


def _marked(mask: int) -> list[int]:
    return [i for i in range(bingo.CELLS) if mask >> i & 1]


async def _calls(db: AsyncSession, game_id: uuid.UUID) -> list[BingoCall]:
    rows = await db.execute(
        text("SELECT seq, value FROM bingo_calls WHERE game_id = :g ORDER BY seq"), {"g": game_id}
    )
    return [BingoCall(r.seq, r.value, bingo_classic.label(r.value)) for r in rows]


async def _called_set(db: AsyncSession, game: GameRow) -> set[int] | None:
    """The called numbers of a classic game; None for Thanksgiving (nothing is called)."""
    if _mode(game) != "classic":
        return None
    return {c.value for c in await _calls(db, game.id)}


def _progress(game: GameRow, squares: list[str], marked_mask: int, called: set[int] | None) -> int:
    """Squares from bingo: from the called numbers in classic, from the marks otherwise."""
    mask = marked_mask if called is None else bingo_classic.called_mask(squares, called)
    return bingo.squares_from_bingo(mask, _win_mode(game))


async def _finish_places(db: AsyncSession, game_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """1-based finishing order by `won_at` (ties, which the game lock prevents, by id)."""
    rows = await db.execute(
        text(
            "SELECT person_id FROM bingo_cards WHERE game_id = :g AND won_at IS NOT NULL "
            "ORDER BY won_at, id"
        ),
        {"g": game_id},
    )
    return {r.person_id: i for i, r in enumerate(rows, start=1)}


async def bingo_state(db: AsyncSession, game: GameRow) -> BingoState:
    """Who is playing and how close each card is, and in classic the numbers called so far.
    Never which squares, never a card, never the seed or a number not yet called."""
    classic = _mode(game) == "classic"
    calls = await _calls(db, game.id) if classic else []
    called = {c.value for c in calls} if classic else None
    places = await _finish_places(db, game.id)
    rows = await db.execute(
        text(
            """
            SELECT p.id, p.name, p.avatar_emoji, p.color, c.squares, c.marked_mask, c.won_at
            FROM bingo_cards c
            JOIN people p ON p.id = c.person_id AND p.household_id = c.household_id
            WHERE c.game_id = :g
            ORDER BY c.created_at, c.id
            """
        ),
        {"g": game.id},
    )
    return BingoState(
        mode=_mode(game),
        calls=calls,
        win_mode=_win_mode(game),
        free_center=bool(game.config.get("free_center", True)),
        end_on_first_win=bool(game.config.get("end_on_first_win", True)),
        players=[
            BingoPlayer(
                r.id,
                r.name,
                r.avatar_emoji,
                r.color,
                _progress(game, list(r.squares), r.marked_mask, called),
                r.won_at is not None,
                places.get(r.id),
            )
            for r in rows
        ],
    )


async def open_game(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    seed: int | None = None,
) -> None:
    """draft -> open: the family can join. Idempotent once open. A classic game stores its
    draw seed here (join needs the game to exist, the first call needs the seed)."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_bingo(game)
    if game.status == "open":
        return
    if game.status != "draft":
        raise Conflict("That round has already started.")
    await db.execute(
        text(
            "UPDATE games SET status = 'open', started_at = now(), "
            "reveal_seed = CASE WHEN :classic THEN COALESCE(reveal_seed, :seed) "
            "ELSE reveal_seed END WHERE id = :g"
        ),
        {"g": game_id, "classic": _mode(game) == "classic", "seed": seed},
    )
    await _audit(db, household_id, account_id, "game.opened", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def start_round(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    """open -> live: marking starts."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_bingo(game)
    if game.status == "live":
        raise Conflict("The round has already started.")
    if game.status != "open":
        raise Conflict("Open the game for players first." if game.status == "draft" else "Over.")
    await db.execute(text("UPDATE games SET status = 'live' WHERE id = :g"), {"g": game_id})
    await _audit(db, household_id, account_id, "game.started", game_id)
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


def _card(
    row: Any, game: GameRow, places: dict[uuid.UUID, int], called: set[int] | None = None
) -> OwnCard:
    return OwnCard(
        person_id=row.person_id,
        squares=list(row.squares),
        marked=_marked(row.marked_mask),
        squares_from_bingo=_progress(game, list(row.squares), row.marked_mask, called),
        won=row.won_at is not None,
        finish_place=places.get(row.person_id),
    )


_CARD = text(
    "SELECT person_id, squares, marked_mask, won_at FROM bingo_cards "
    "WHERE game_id = :g AND person_id = :p"
)


async def join(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    seed: int,
) -> OwnCard:
    """Take a seat and get a card. Idempotent: joining again returns the same card."""
    game = await _load(db, household_id, game_id, lock="SHARE")
    _require_bingo(game)
    await consent_service.require_household_consent(db)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status == "draft":
        raise Conflict("The game isn't open for players yet.")
    if game.status == "ended":
        raise Conflict("The round is over.")
    free = bool(game.config.get("free_center", True))
    rng = random.Random(seed ^ person_id.int)
    squares = (
        bingo_classic.generate_classic_card(rng, free)
        if _mode(game) == "classic"
        else bingo.generate_card(bingo_pool.THANKSGIVING_POOL, rng, free)
    )
    created = await db.scalar(
        text(
            "INSERT INTO bingo_cards (household_id, game_id, person_id, squares, marked_mask) "
            "VALUES (:h, :g, :p, :squares, :mask) "
            "ON CONFLICT (game_id, person_id) DO NOTHING RETURNING id"
        ),
        {
            "h": household_id,
            "g": game_id,
            "p": person_id,
            "squares": squares,
            "mask": bingo.initial_mask(free),
        },
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
    return _card(row, game, await _finish_places(db, game_id), await _called_set(db, game))


async def reroll_card(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    seed: int,
) -> OwnCard:
    """Replace your own card with a fresh one, any number of times, while the round is `open`
    (before the host starts it). Marks reset to the free centre's initial mask. The seed follows
    `join`'s pattern but also mixes in the current squares, so a pinned seed equal to the join
    seed still yields a different card; a guard loop makes "differs from the old card" certain."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_bingo(game)
    await consent_service.require_household_consent(db)
    await people_service.require_can_act_as(db, device_id, person_id)
    if game.status != "open":
        raise Conflict(
            "The round is over."
            if game.status == "ended"
            else "The round has started, so cards are locked."
            if game.status == "live"
            else "The game isn't open for players yet."
        )
    row = (
        await db.execute(text(str(_CARD) + " FOR UPDATE"), {"g": game_id, "p": person_id})
    ).first()
    if row is None:
        raise NotFound("You haven't joined this game.")
    free = bool(game.config.get("free_center", True))
    old = list(row.squares)
    base = seed ^ person_id.int ^ zlib.crc32("|".join(old).encode())
    squares = old
    for attempt in range(16):
        rng = random.Random(base + attempt)
        squares = (
            bingo_classic.generate_classic_card(rng, free)
            if _mode(game) == "classic"
            else bingo.generate_card(bingo_pool.THANKSGIVING_POOL, rng, free)
        )
        if squares != old:
            break
    await db.execute(
        text(
            "UPDATE bingo_cards SET squares = :squares, marked_mask = :mask "
            "WHERE game_id = :g AND person_id = :p"
        ),
        {"squares": squares, "mask": bingo.initial_mask(free), "g": game_id, "p": person_id},
    )
    publish_game_after_commit(db, game_id, events.GAME_ACTIVITY)
    fresh = (await db.execute(_CARD, {"g": game_id, "p": person_id})).one()
    return _card(fresh, game, await _finish_places(db, game_id), await _called_set(db, game))


async def my_cards(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID, device_id: uuid.UUID
) -> list[OwnCard]:
    """Cards of the people actively bound to this phone, and nobody else's."""
    game = await _load(db, household_id, game_id)
    _require_bingo(game)
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
    places = await _finish_places(db, game_id)
    called = await _called_set(db, game)
    return [_card(r, game, places, called) for r in rows]


async def set_mark(
    db: AsyncSession,
    household_id: uuid.UUID,
    game_id: uuid.UUID,
    index: int,
    *,
    device_id: uuid.UUID,
    person_id: uuid.UUID,
    marked: bool,
) -> OwnCard:
    """Mark or unmark one square on your own card. Idempotent. In Thanksgiving the game row's
    lock makes the completing mark the single decision point: whoever takes the lock first and
    finishes a pattern is the first winner, and `end_on_first_win` closes the round in that same
    transaction, so a second phone completing at the same instant gets 409. In classic a mark
    is limited to called numbers (409 otherwise) and never wins: only a host check does."""
    if not 0 <= index < bingo.CELLS:
        raise Invalid("No such square.")
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_bingo(game)
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
    classic = _mode(game) == "classic"
    called = await _called_set(db, game)
    free = bool(game.config.get("free_center", True))
    mask = row.marked_mask
    if bool(mask >> index & 1) != marked:
        if (
            marked
            and called is not None
            and not bingo_classic.is_called(row.squares[index], called)
        ):
            raise Conflict("That number hasn't been called.")
        mask = bingo.toggle_mark(mask, index, free)
    if mask == row.marked_mask:
        return _card(row, game, await _finish_places(db, game_id), called)
    just_won = not classic and row.won_at is None and bingo.has_win(mask, _win_mode(game))
    # clock_timestamp(), not now(): now() is the transaction's start, which would let the
    # second lock holder look earlier than the first.
    await db.execute(
        text(
            "UPDATE bingo_cards SET marked_mask = :m"
            + (", won_at = clock_timestamp()" if just_won else "")
            + " WHERE game_id = :g AND person_id = :p"
        ),
        {"m": mask, "g": game_id, "p": person_id},
    )
    if just_won and game.config.get("end_on_first_win", True):
        await db.execute(
            text("UPDATE games SET status = 'ended', ended_at = now() WHERE id = :g"),
            {"g": game_id},
        )
    publish_game_after_commit(
        db, game_id, events.GAME_CHANGED if just_won else events.GAME_ACTIVITY
    )
    fresh = (await db.execute(_CARD, {"g": game_id, "p": person_id})).one()
    return _card(fresh, game, await _finish_places(db, game_id), called)


# ---- Classic bingo: the host's calls and checks ----


async def draw(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    expected_seq: int,
) -> BingoCall:
    """Call the next number. `expected_seq` is how many calls the host's screen showed; a
    different count (double tap, second host window) is 409 and inserts nothing."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_classic(game)
    if game.status != "live":
        raise Conflict("Start the round first." if game.status in ("draft", "open") else "Over.")
    count = await db.scalar(
        text("SELECT count(*) FROM bingo_calls WHERE game_id = :g"), {"g": game_id}
    )
    if count != expected_seq:
        raise Conflict("The board moved on. Check the last call and try again.")
    if count >= bingo_classic.MAX_NUMBER:
        raise Conflict("Every number has been called.")
    seed = await db.scalar(text("SELECT reveal_seed FROM games WHERE id = :g"), {"g": game_id})
    if seed is None:
        raise Conflict("This game has no draw seed.")
    value = bingo_classic.call_order(int(seed))[count]
    await db.execute(
        text("INSERT INTO bingo_calls (household_id, game_id, seq, value) VALUES (:h, :g, :s, :v)"),
        {"h": household_id, "g": game_id, "s": count, "v": value},
    )
    await _audit(
        db, household_id, account_id, "game.bingo_called", game_id, {"seq": count, "value": value}
    )
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)
    return BingoCall(count, value, bingo_classic.label(value))


async def check(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    person_id: uuid.UUID,
) -> BingoCheck:
    """Verify a spoken "bingo" against the called numbers (not the player's taps). A false
    claim leaves the game running and sends no event; a true one records the win and, with
    `end_on_first_win`, ends the game in the same transaction."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_classic(game)
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
        raise NotFound("That player has no card.")
    win_mode = _win_mode(game)
    called = {c.value for c in await _calls(db, game_id)}
    mask = bingo_classic.called_mask(list(row.squares), called)
    won_pattern = bingo_classic.pattern(mask, win_mode)
    valid = won_pattern is not None
    result = BingoCheck(valid, win_mode, won_pattern, bingo.squares_from_bingo(mask, win_mode))
    await _audit(
        db,
        household_id,
        account_id,
        "game.bingo_checked",
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
