"""Response schemas for the night reel (ADR-0018 amendment "Night reel"). The OpenAPI contract.

Read-only. A person is only ever a name, an avatar and a colour: never a PIN, and never the
author of an anonymous note (`author` is null for it, for everyone).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class ReelPersonOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str


class ReelStandingOut(BaseModel):
    person: ReelPersonOut
    points: int


class ReelItemOut(BaseModel):
    """One slide. Only the fields of its `kind` are set."""

    kind: Literal["quote", "winner", "leaderboard", "photo"]
    # Stable across refetches (`quote:{note}`, `winner:bingo:{game}:{person}`, ...).
    id: str
    game_kind: str | None = None
    game_title: str | None = None
    # quote
    body: str | None = None
    author: ReelPersonOut | None = None
    # winner
    label: str | None = None
    winners: list[ReelPersonOut] = []
    place: int | None = None
    points: int | None = None
    # leaderboard
    standings: list[ReelStandingOut] = []
    final: bool | None = None
    # photo (a presigned GET minted for this request, ~10 minutes)
    photo_url: str | None = None
    photo_by: ReelPersonOut | None = None


class ReelOut(BaseModel):
    """The reel in its show order. A screen finds the slide on show with no tick events:
    `floor((now + (server_now - Date.now()) - anchor) / dwell_seconds) mod len(items)`."""

    window: Literal["tonight", "all"]
    since: datetime | None
    server_now: datetime
    anchor: datetime
    dwell_seconds: int
    items: list[ReelItemOut]
