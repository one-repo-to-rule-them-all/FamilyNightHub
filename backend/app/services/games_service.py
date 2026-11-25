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

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.games import jar
from app.realtime import events
from app.realtime.publisher import publish_game_after_commit
from app.services import consent_service, people_service
from app.services.errors import Conflict, Invalid, NotFound

_AUDIT = text(
    "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
    "target_id, data) VALUES (:h, :a, :action, 'game', :t, :data)"
).bindparams(bindparam("data", type_=JSONB))

# The jar (slice A) and scattergories (slice C); bingo arrives with slice B.
AVAILABLE_KINDS = frozenset({"gratitude_jar", "scattergories"})


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
class JarState:
    note_count: int
    revealed_count: int
    remaining: int
    current: ShownNote | None
    revealed: list[ShownNote]


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
) -> GameRow:
    if kind not in AVAILABLE_KINDS:
        raise Invalid("That game isn't available yet.")
    clean = " ".join(title.split())
    if not clean:
        raise Invalid("Give the game a name.")
    row = (
        await db.execute(
            text(
                "INSERT INTO games (household_id, kind, title, status, config, "
                "created_by_account_id, started_at) "
                "VALUES (:h, :kind, :title, 'open', :config, :a, now()) "
                "RETURNING id, kind, title, status, created_at, config"
            ).bindparams(bindparam("config", type_=JSONB)),
            {
                "h": household_id,
                "kind": kind,
                "title": clean,
                "config": {"allow_anonymous": allow_anonymous},
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


async def jar_state(db: AsyncSession, game_id: uuid.UUID) -> JarState:
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
    return JarState(
        note_count=counts.total,
        revealed_count=counts.done,
        remaining=counts.total - counts.done,
        current=shown[-1] if shown else None,
        revealed=shown,
    )


async def snapshot(
    db: AsyncSession, household_id: uuid.UUID, game_id: uuid.UUID
) -> tuple[GameRow, JarState | None]:
    game = await _load(db, household_id, game_id)
    return game, (await jar_state(db, game_id) if game.kind == "gratitude_jar" else None)


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


async def start_reveal(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    game_id: uuid.UUID,
    *,
    seed: int,
) -> None:
    """Close the jar to new notes and fix a shuffled order for the unhidden ones."""
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_jar(game)
    if game.status == "live":
        raise Conflict("The reveal has already started.")
    if game.status != "open":
        raise Conflict("The jar is over.")
    ids = [
        r.id
        for r in await db.execute(
            text("SELECT id FROM gratitude_notes WHERE game_id = :g AND hidden_at IS NULL"),
            {"g": game_id},
        )
    ]
    if not ids:
        raise Conflict("Nothing in the jar yet.")
    for position, note_id in enumerate(jar.reveal_order(ids, seed)):
        await db.execute(
            text("UPDATE gratitude_notes SET reveal_position = :pos WHERE id = :n"),
            {"pos": position, "n": note_id},
        )
    await db.execute(
        text("UPDATE games SET status = 'live', reveal_seed = :seed WHERE id = :g"),
        {"seed": seed, "g": game_id},
    )
    await _audit(db, household_id, account_id, "game.reveal_started", game_id, {"notes": len(ids)})
    publish_game_after_commit(db, game_id, events.GAME_CHANGED)


async def reveal_next(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, game_id: uuid.UUID
) -> None:
    game = await _load(db, household_id, game_id, lock="UPDATE")
    _require_jar(game)
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
