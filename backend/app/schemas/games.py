"""Request/response schemas for games and the Gratitude Jar (ADR-0018). The OpenAPI contract.

The snapshot never carries a note that has not been revealed (it is the host's moderation
list and the author's own list that do), and never the author of an anonymous note.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

GameKind = Literal["gratitude_jar", "bingo", "scattergories", "loteria"]
LoteriaPattern = Literal["line", "corners", "center", "full"]
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
    # Bingo mode: Thanksgiving (honour-system marks, the API default) or classic (host-called
    # numbers). Fixed at creation.
    mode: Literal["thanksgiving", "classic"] = "thanksgiving"
    # Gratitude Jar: cycle notes by themselves once started, or show them one by one.
    reveal_mode: Literal["cycle", "manual"] = "cycle"
    cycle_seconds: int = Field(default=12, ge=5, le=60)
    # Loteria: which pattern wins (end_on_first_win above applies too).
    pattern: LoteriaPattern = "line"


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


class JarCycleOut(BaseModel):
    """Everything a screen needs to find the note on show with no tick events: the index is
    `floor((now + (server_now - Date.now()) - anchor_at) / dwell_seconds) mod count`, or
    `paused_index` while paused."""

    anchor_at: datetime
    server_now: datetime
    dwell_seconds: int
    paused_index: int | None


class JarOut(BaseModel):
    mode: Literal["cycle", "manual"] = "manual"
    # Null for a manual jar, or a cycle jar that has not started.
    cycle: JarCycleOut | None = None
    note_count: int
    revealed_count: int
    remaining: int
    # Manual: the note on screen now (the latest one revealed), if any. Null in cycle mode.
    current: JarNoteOut | None
    # The notes on show, in `reveal_position` order (the cycle order in cycle mode).
    revealed: list[JarNoteOut]


class GameSummaryOut(BaseModel):
    id: uuid.UUID
    kind: GameKind
    title: str
    status: GameStatus
    created_at: datetime
    # Bingo only: which kind of bingo this is, so a list can say "Classic bingo". Null otherwise.
    mode: Literal["thanksgiving", "classic"] | None = None


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


class BingoCallOut(BaseModel):
    seq: int
    value: int
    # "B7", "G52".
    label: str


class BingoOut(BaseModel):
    mode: Literal["thanksgiving", "classic"] = "thanksgiving"
    # Classic only: the numbers called so far, in call order. Never a future call.
    calls: list[BingoCallOut] = []
    last_call: BingoCallOut | None = None
    win_mode: Literal["line", "blackout"]
    free_center: bool
    end_on_first_win: bool
    players: list[BingoPlayerOut]


class GameOut(GameSummaryOut):
    allow_anonymous: bool
    jar: JarOut | None
    bingo: BingoOut | None = None
    scatter: ScatterOut | None = None
    loteria: LoteriaOut | None = None


class BingoJoinIn(BaseModel):
    person_id: uuid.UUID


class BingoDrawIn(BaseModel):
    # How many calls the host's screen showed; a different server count is 409.
    expected_seq: int = Field(ge=0, le=75)


class BingoCheckIn(BaseModel):
    person_id: uuid.UUID


class BingoCheckOut(BaseModel):
    valid: bool
    win_mode: Literal["line", "blackout"]
    # Indices of the first complete line (or all 25) when valid, else null.
    pattern: list[int] | None
    # Squares still to be called in the closest pattern (0 when valid).
    missing: int


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


# ---- Scattergories (ADR-0018 slice C) ----

ScatterState = Literal["lobby", "running", "closed", "revealed"]
Verdict = Literal["accepted", "rejected"]


class ScatterPlayerOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    # How many categories this player has filled in this round, never what they wrote.
    answered: int


class ScatterRoundOut(BaseModel):
    round_no: int
    letter: str
    categories: list[str]
    duration_seconds: int
    # The server's clock for this round. Clients count down locally against `server_now`.
    ends_at: datetime
    # `running` until `ends_at`, `closed` after it, `revealed` once the host revealed.
    state: ScatterState


class ScatterAnswerOut(BaseModel):
    answer_id: uuid.UUID
    person_id: uuid.UUID
    category_index: int
    text: str
    valid: bool
    point: int
    verdict: Verdict | None


class ScatterScoreOut(BaseModel):
    person_id: uuid.UUID
    points: int


class ScatterRevealedOut(BaseModel):
    round_no: int
    letter: str
    categories: list[str]
    answers: list[ScatterAnswerOut]
    scores: list[ScatterScoreOut]


class ScatterStandingOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    points: int


class ScatterOut(BaseModel):
    server_now: datetime
    # The latest round (any state), or null before the first.
    current: ScatterRoundOut | None
    players: list[ScatterPlayerOut]
    # Revealed rounds only: nobody sees an answer before the host reveals.
    revealed: list[ScatterRevealedOut]
    leaderboard: list[ScatterStandingOut]


class ScatterJoinIn(BaseModel):
    person_id: uuid.UUID


class ScatterRoundIn(BaseModel):
    # Omit to draw `count` categories at random.
    categories: list[str] | None = Field(default=None, max_length=12)
    count: int = Field(default=6, ge=1, le=12)
    duration_seconds: int = Field(default=120, ge=10, le=900)


class ScatterDrawOut(BaseModel):
    categories: list[str]


class ScatterAnswerIn(BaseModel):
    category_index: int = Field(ge=0, le=11)
    # Empty clears the answer.
    text: str = Field(max_length=400)


class ScatterSubmitIn(BaseModel):
    person_id: uuid.UUID
    answers: list[ScatterAnswerIn] = Field(max_length=12)


class ScatterOwnAnswerOut(BaseModel):
    person_id: uuid.UUID
    round_no: int
    category_index: int
    text: str


class ScatterVerdictIn(BaseModel):
    verdict: Verdict | None


ScatterReviewKind = Literal[
    "near_duplicate", "short", "duplicate", "auto_rejected_letter", "host_rejected"
]


class ScatterReviewAnswerOut(BaseModel):
    answer_id: uuid.UUID
    person_id: uuid.UUID
    name: str
    text: str
    verdict: Verdict | None
    points: int


class ScatterReviewItemOut(BaseModel):
    kind: ScatterReviewKind
    category_index: int
    category: str
    # True when the plural rule merged these answers (both 0 until the host counts them
    # separately); false for a typo match, which scores as written.
    merged: bool
    answers: list[ScatterReviewAnswerOut]


class ScatterReviewOut(BaseModel):
    """What a revealed round needs from the host (ADR-0018 amendment, part C). Computed from
    the same rows as scoring and never stored."""

    round_no: int
    letter: str
    needs_decision: list[ScatterReviewItemOut]
    informational: list[ScatterReviewItemOut]
    auto_accepted_count: int
    total: int


class TvTargetOut(BaseModel):
    """The game the host sent to the paired TV; null when none (or it ended)."""

    game_id: uuid.UUID | None


class TvTargetIn(BaseModel):
    game_id: uuid.UUID | None = None


# ---- Loteria (ADR-0018 amendment 2026-11-26) ----


class LoteriaCallOut(BaseModel):
    seq: int
    # Deck card id, 1-54.
    card_id: int
    name_es: str
    name_en: str
    emoji: str


class LoteriaPlayerOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    # Squares still to be called in this player's closest pattern (0 = complete). Never which.
    missing: int
    won: bool
    finish_place: int | None


class LoteriaOut(BaseModel):
    pattern: LoteriaPattern
    end_on_first_win: bool
    # The cards called so far, in order. Never a future call or the seed.
    calls: list[LoteriaCallOut]
    last_call: LoteriaCallOut | None = None
    players: list[LoteriaPlayerOut]


class LoteriaJoinIn(BaseModel):
    person_id: uuid.UUID


class LoteriaDrawIn(BaseModel):
    # How many calls the host's screen showed; a different server count is 409.
    expected_seq: int = Field(ge=0, le=54)


class LoteriaCheckIn(BaseModel):
    person_id: uuid.UUID


class LoteriaCheckOut(BaseModel):
    valid: bool
    pattern: LoteriaPattern
    # Square indices (0-15) of the first complete pattern when valid, else null.
    squares: list[int] | None
    # Squares still to be called in the closest pattern (0 when valid).
    missing: int


class LoteriaTablaOut(BaseModel):
    person_id: uuid.UUID
    # 16 deck card ids, row-major 4 x 4.
    squares: list[int]
    # Indexes (0-15) of the marked squares.
    marked: list[int]
    missing: int
    won: bool
    finish_place: int | None


GameOut.model_rebuild()
