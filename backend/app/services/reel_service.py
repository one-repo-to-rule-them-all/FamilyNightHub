"""The night reel (ADR-0018 amendment "Night reel"): quotes, winners, leaderboards and photos
from the household's recent activity, derived from existing tables (no migration) and returned
in a seeded show order. A pure read: no write, no audit row, no event.

Only content the household's moderation already allows leaves here: a hidden note and a hidden
or unfinished photo are never selected, and an anonymous note's author never leaves the
database (the SQL does not select it). A game kind contributes slides through `GAME_PROVIDERS`,
so a new kind (Lotería) registers one function instead of editing the build.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import reel as rules
from app.integrations.storage import PhotoStorage
from app.schemas.reel import ReelItemOut, ReelOut, ReelPersonOut, ReelStandingOut
from app.services import scatter_service


@dataclass
class _Item:
    kind: str
    id: str
    fields: dict[str, Any] = field(default_factory=dict)


Provider = Callable[[AsyncSession, uuid.UUID, datetime | None], Awaitable[list[_Item]]]


def _person(row: Any) -> ReelPersonOut:
    return ReelPersonOut(
        person_id=row.pid, name=row.pname, avatar_emoji=row.pemoji, color=row.pcolor
    )


async def _quotes(db: AsyncSession, household_id: uuid.UUID, since: datetime | None) -> list[_Item]:
    """Revealed, unhidden notes (ended jars too). The author columns are NULL in SQL for an
    anonymous note, so the name cannot reach the response by mistake."""
    rows = await db.execute(
        text(
            """
            SELECT n.id, n.body, g.title,
                   CASE WHEN n.anonymous THEN NULL ELSE p.id END AS pid,
                   CASE WHEN n.anonymous THEN NULL ELSE p.name END AS pname,
                   CASE WHEN n.anonymous THEN NULL ELSE p.avatar_emoji END AS pemoji,
                   CASE WHEN n.anonymous THEN NULL ELSE p.color END AS pcolor
            FROM gratitude_notes n
            JOIN games g ON g.id = n.game_id AND g.household_id = n.household_id
            JOIN people p ON p.id = n.person_id AND p.household_id = n.household_id
            WHERE n.household_id = :h AND n.revealed_at IS NOT NULL AND n.hidden_at IS NULL
              AND (CAST(:since AS timestamptz) IS NULL OR n.revealed_at >= :since)
            ORDER BY n.revealed_at DESC, n.id
            LIMIT :cap
            """
        ),
        {"h": household_id, "since": since, "cap": rules.MAX_QUOTES},
    )
    return [
        _Item(
            "quote",
            f"quote:{r.id}",
            {
                "game_kind": "gratitude_jar",
                "game_title": r.title,
                "body": r.body,
                "author": None if r.pid is None else _person(r),
            },
        )
        for r in rows
    ]


async def _bingo_winners(
    db: AsyncSession, household_id: uuid.UUID, since: datetime | None
) -> list[_Item]:
    """Every card with `won_at` in the window, with its finishing place in its game."""
    rows = await db.execute(
        text(
            """
            SELECT * FROM (
              SELECT c.game_id, g.title, g.config->>'mode' AS mode, c.won_at,
                     p.id AS pid, p.name AS pname, p.avatar_emoji AS pemoji, p.color AS pcolor,
                     row_number() OVER (PARTITION BY c.game_id ORDER BY c.won_at, c.id) AS place
              FROM bingo_cards c
              JOIN games g ON g.id = c.game_id AND g.household_id = c.household_id
              JOIN people p ON p.id = c.person_id AND p.household_id = c.household_id
              WHERE c.household_id = :h AND c.won_at IS NOT NULL
            ) w
            WHERE CAST(:since AS timestamptz) IS NULL OR w.won_at >= :since
            ORDER BY w.won_at DESC, w.pid
            """
        ),
        {"h": household_id, "since": since},
    )
    return [
        _Item(
            "winner",
            f"winner:bingo:{r.game_id}:{r.pid}",
            {
                "game_kind": "bingo",
                "game_title": r.title,
                "label": "Classic bingo" if r.mode == "classic" else "Thanksgiving bingo",
                "winners": [_person(r)],
                "place": r.place,
            },
        )
        for r in rows
    ]


async def _scatter_items(
    db: AsyncSession, household_id: uuid.UUID, since: datetime | None
) -> list[_Item]:
    """A round's top scorers (points > 0, ties all shown) for each round revealed in the
    window, and each game's standings, scored by the existing pure rules."""
    games = list(
        await db.execute(
            text(
                """
                SELECT g.id, g.title, g.status FROM games g
                WHERE g.household_id = :h AND g.kind = 'scattergories' AND EXISTS (
                  SELECT 1 FROM scatter_rounds r WHERE r.game_id = g.id
                    AND r.revealed_at IS NOT NULL
                    AND (CAST(:since AS timestamptz) IS NULL OR r.revealed_at >= :since))
                ORDER BY g.created_at, g.id
                """
            ),
            {"h": household_id, "since": since},
        )
    )
    items: list[_Item] = []
    for g in games:
        state = await scatter_service.state(db, g.id)
        revealed_at = {
            r.round_no: r.revealed_at
            for r in await db.execute(
                text("SELECT round_no, revealed_at FROM scatter_rounds WHERE game_id = :g"),
                {"g": g.id},
            )
        }
        by_id = {p.person_id: p for p in state.players}

        def person(pid: uuid.UUID, by_id: dict[uuid.UUID, Any] = by_id) -> ReelPersonOut:
            p = by_id[pid]
            return ReelPersonOut(
                person_id=p.person_id, name=p.name, avatar_emoji=p.avatar_emoji, color=p.color
            )

        for rnd in state.revealed:
            at = revealed_at.get(rnd.round_no)
            if since is not None and (at is None or at < since):
                continue
            top = max(rnd.scores.values(), default=0)
            if top <= 0:
                continue
            winners = sorted(
                (pid for pid, pts in rnd.scores.items() if pts == top and pid in by_id),
                key=lambda pid: (by_id[pid].name.casefold(), str(pid)),
            )
            if winners:
                items.append(
                    _Item(
                        "winner",
                        f"winner:scatter:{g.id}:{rnd.round_no}",
                        {
                            "game_kind": "scattergories",
                            "game_title": g.title,
                            "label": f"Round {rnd.round_no}, letter {rnd.letter}",
                            "winners": [person(pid) for pid in winners],
                            "place": 1,
                            "points": top,
                        },
                    )
                )
        ranked = [s for s in state.leaderboard if s.points > 0][: rules.LEADERBOARD_TOP]
        if ranked:
            items.append(
                _Item(
                    "leaderboard",
                    f"leaderboard:scatter:{g.id}",
                    {
                        "game_kind": "scattergories",
                        "game_title": g.title,
                        "standings": [
                            ReelStandingOut(person=person(s.person_id), points=s.points)
                            for s in ranked
                        ],
                        "final": g.status == "ended",
                    },
                )
            )
    return items


async def _photos(
    db: AsyncSession, storage: PhotoStorage | None, household_id: uuid.UUID, since: datetime | None
) -> list[_Item]:
    """Ready photos only (a hidden or pending one is never listed). One presigned GET per photo
    is minted now, after the household check (ADR-0005); without storage the reel has none."""
    if storage is None:
        return []
    rows = await db.execute(
        text(
            """
            SELECT ph.id, ph.object_key, p.id AS pid, p.name AS pname,
                   p.avatar_emoji AS pemoji, p.color AS pcolor
            FROM photos ph
            JOIN people p ON p.id = ph.person_id AND p.household_id = ph.household_id
            WHERE ph.household_id = :h AND ph.status = 'ready'
              AND (CAST(:since AS timestamptz) IS NULL OR ph.created_at >= :since)
            ORDER BY ph.created_at DESC, ph.id
            LIMIT :cap
            """
        ),
        {"h": household_id, "since": since, "cap": rules.MAX_PHOTOS},
    )
    return [
        _Item(
            "photo",
            f"photo:{r.id}",
            {"photo_url": storage.presign_get(r.object_key), "photo_by": _person(r)},
        )
        for r in rows
    ]


# A game kind registers how its slides reach the reel. Lotería adds one line here.
GAME_PROVIDERS: dict[str, Provider] = {
    "bingo": _bingo_winners,
    "scattergories": _scatter_items,
}


async def build(
    db: AsyncSession,
    storage: PhotoStorage | None,
    household_id: uuid.UUID,
    *,
    window: rules.Window,
    seed: int | None = None,
) -> ReelOut:
    now: datetime = (await db.execute(text("SELECT clock_timestamp()"))).scalar_one()
    since = rules.window_since(window, now)
    items = await _quotes(db, household_id, since)
    for provider in GAME_PROVIDERS.values():
        items += await provider(db, household_id, since)
    items += await _photos(db, storage, household_id, since)

    order = rules.order_ids(
        (i.id for i in items), rules.reel_seed(household_id, now) if seed is None else seed
    )
    by_id = {i.id: i for i in items}
    return ReelOut(
        window=window,
        since=since,
        server_now=now,
        anchor=rules.anchor_for(now),
        dwell_seconds=rules.DWELL_SECONDS,
        items=[
            ReelItemOut.model_validate({"kind": by_id[i].kind, "id": i, **by_id[i].fields})
            for i in order
        ],
    )
