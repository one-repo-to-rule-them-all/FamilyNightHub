"""Request/response schemas for games and the Gratitude Jar (ADR-0018). The OpenAPI contract.

The snapshot never carries a note that has not been revealed (it is the host's moderation
list and the author's own list that do), and never the author of an anonymous note.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

GameKind = Literal["gratitude_jar", "bingo", "scattergories"]
GameStatus = Literal["draft", "open", "live", "ended"]


class GameCreateIn(BaseModel):
    kind: GameKind
    title: str = Field(min_length=1, max_length=80)
    # Gratitude Jar: may a note be dropped without a name on it?
    allow_anonymous: bool = True
    # Bingo: what counts as a win, whether the middle square is free, and whether the first
    # win ends the round.
    win_mode: Literal["line", "blackout"] = "line"
    free_center: bool = True
    end_on_first_win: bool = True


class JarAuthorOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str


class JarNoteOut(BaseModel):
    id: uuid.UUID
    body: str
    # Null for an anonymous note, for everyone.
    author: JarAuthorOut | None
    revealed_at: datetime


class JarOut(BaseModel):
    note_count: int
    revealed_count: int
    remaining: int
    # The note on screen now (the latest one revealed), if any.
    current: JarNoteOut | None
    revealed: list[JarNoteOut]


class GameSummaryOut(BaseModel):
    id: uuid.UUID
    kind: GameKind
    title: str
    status: GameStatus
    created_at: datetime


class BingoPlayerOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    # The fewest unmarked squares in any one winning pattern (0 = won). Never which squares.
    squares_from_bingo: int
    won: bool
    # 1 for the first finished card, 2 for the next; null until a card wins.
    finish_place: int | None


class BingoOut(BaseModel):
    win_mode: Literal["line", "blackout"]
    free_center: bool
    end_on_first_win: bool
    players: list[BingoPlayerOut]


class GameOut(GameSummaryOut):
    allow_anonymous: bool
    jar: JarOut | None
    bingo: BingoOut | None = None


class BingoJoinIn(BaseModel):
    person_id: uuid.UUID


class BingoCardOut(BaseModel):
    person_id: uuid.UUID
    # 25 squares, row-major; the free centre reads "FREE".
    squares: list[str]
    # Indexes of the marked squares.
    marked: list[int]
    squares_from_bingo: int
    won: bool
    finish_place: int | None


class NoteIn(BaseModel):
    person_id: uuid.UUID
    body: str = Field(min_length=1, max_length=2000)
    anonymous: bool = False


class OwnNoteOut(BaseModel):
    id: uuid.UUID
    person_id: uuid.UUID
    body: str
    anonymous: bool
    revealed: bool


class ModerationNoteOut(BaseModel):
    id: uuid.UUID
    body: str
    anonymous: bool
    # Null for an anonymous note, even here (ADR-0018).
    author: JarAuthorOut | None
    revealed_at: datetime | None
    hidden_at: datetime | None
