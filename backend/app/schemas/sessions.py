"""Request/response schemas for nights, the shortlist and TMDB search. The OpenAPI contract.

The night snapshot never has ballot fields; its `result` stays null until reveal
(ADR-0004/0006).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.domain.generator import MAX_COUNT as MAX_CANDIDATES
from app.domain.session_state import MAX_OPTIONS
from app.schemas.admin import AgeCap

SessionStatus = Literal["draft", "voting", "revealed", "tonight", "closed"]
OptionSource = Literal["manual", "owned", "streaming", "tmdb"]
VotingMethod = Literal["top3", "approval", "pick_one"]


class SessionCreateIn(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    # Omit to use the household's default_voting_method (ADR-0010).
    voting_method: VotingMethod | None = None


class SessionUpdateIn(BaseModel):
    """Draft-only changes (ADR-0010): the method locks with the shortlist."""

    voting_method: VotingMethod


class SlideshowIn(BaseModel):
    """Start (`true`) or stop (`false`) the paired TV's slideshow (issue #41)."""

    playing: bool


class SessionCreatedOut(BaseModel):
    session_id: uuid.UUID
    # Shown once: only its hash is stored, so it cannot be fetched again. Rotate if lost.
    night_code: str


class NightCodeOut(BaseModel):
    night_code: str


class OptionIn(BaseModel):
    """Exactly one of: a movie already in the library, a TMDB id (upserts the library row),
    or a typed title (for when TMDB is off or doesn't have it)."""

    movie_id: uuid.UUID | None = None
    tmdb_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    year: int | None = Field(default=None, ge=1870, le=2100)
    # With tmdb_id only: where the candidate came from (POST .../generate). A library
    # movie_id derives `owned` itself; a typed title is `manual`.
    source: Literal["streaming", "tmdb"] | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> OptionIn:
        given = [v for v in (self.movie_id, self.tmdb_id, self.title) if v is not None]
        if len(given) != 1:
            raise ValueError("give exactly one of movie_id, tmdb_id or title")
        if self.title is not None and not self.title.strip():
            raise ValueError("title must not be blank")
        if self.year is not None and self.title is None:
            raise ValueError("year goes with a typed title only")
        if self.source is not None and self.tmdb_id is None:
            raise ValueError("source goes with a tmdb_id only")
        return self


class ReorderIn(BaseModel):
    option_ids: list[uuid.UUID] = Field(max_length=MAX_OPTIONS)


class OptionOut(BaseModel):
    id: uuid.UUID
    movie_id: uuid.UUID
    title: str
    year: int | None
    poster_path: str | None
    source: OptionSource
    position: int


class SessionOut(BaseModel):
    id: uuid.UUID
    title: str | None
    status: SessionStatus
    voting_method: VotingMethod
    # The most entries one ballot may hold, fixed when voting opens; null while in draft.
    # top3 min(3, options - 1) (ADR-0006), pick_one 1, approval = options (ADR-0010).
    ballot_size: int | None
    options: list[OptionOut]
    created_at: datetime
    voting_opened_at: datetime | None
    revealed_at: datetime | None
    closed_at: datetime | None
    # Null until the night is revealed: tallies are hidden while voting (ADR-0006).
    result: VotingResultOut | None
    # The family's average score; null until ratings open (`tonight`/`closed`).
    rating: RatingSummaryOut | None
    # The host's slideshow control (issue #41). `auto`: the TV plays once the night is
    # `tonight` (the default). `playing`: the host pressed Start at `slideshow_started_at`.
    # `stopped`: the host pressed Stop; the TV holds on "drop your photos".
    slideshow: Literal["auto", "playing", "stopped"]
    slideshow_started_at: datetime | None


class TmdbResultOut(BaseModel):
    tmdb_id: int
    title: str
    year: int | None
    poster_path: str | None


class ProviderOut(BaseModel):
    provider_id: int
    name: str
    logo_path: str | None


class ProvidersOut(BaseModel):
    providers: list[ProviderOut]
    # JustWatch attribution, required wherever this list is shown.
    attribution: str


# --- Candidate generator (ADR-0007) ------------------------------------------------------

Genre = Literal[
    "Action",
    "Adventure",
    "Animation",
    "Comedy",
    "Crime",
    "Documentary",
    "Drama",
    "Family",
    "Fantasy",
    "History",
    "Horror",
    "Music",
    "Mystery",
    "Romance",
    "Science Fiction",
    "TV Movie",
    "Thriller",
    "War",
    "Western",
]


class GenerateIn(BaseModel):
    """Roll candidates without adding them. Omit `age_cap` to use the night's cap (else the
    household default); send `age_cap: null` for no cap tonight."""

    count: int = Field(default=12, ge=1, le=MAX_CANDIDATES)
    genre: Genre | None = None
    max_runtime: int | None = Field(default=None, ge=30, le=400)
    age_cap: AgeCap | None = None


class CandidateOut(BaseModel):
    # Set for owned titles (add with movie_id); TMDB titles are added with tmdb_id + source.
    movie_id: uuid.UUID | None
    tmdb_id: int | None
    title: str
    year: int | None
    poster_path: str | None
    source: Literal["owned", "streaming", "tmdb"]
    us_cert: str | None
    runtime: int | None
    # The household's services this title streams on (JustWatch data); streaming only.
    providers: list[str]


class AttributionOut(BaseModel):
    tmdb: str
    # Set whenever any candidate shows streaming data; the UI must show it with them.
    justwatch: str | None


class GenerateOut(BaseModel):
    candidates: list[CandidateOut]
    # The cap applied tonight (null = none).
    age_cap: AgeCap | None
    # TMDB was off or down: only owned titles were rolled.
    tmdb_unavailable: bool
    attribution: AttributionOut


# --- Voting (ADR-0006) -----------------------------------------------------------------


class RankIn(BaseModel):
    option_id: uuid.UUID
    rank: int = Field(ge=1, le=MAX_OPTIONS)


class BallotIn(BaseModel):
    """One person's ballot, replacing any earlier one. Ranks run 1..m with no gaps,
    m <= the night's ballot_size. top3: rank 1 alone is fine. pick_one: one option at
    rank 1. approval: the approved options numbered 1..m; that order means nothing
    (ADR-0010). An empty ballot is never valid."""

    person_id: uuid.UUID
    ranks: list[RankIn] = Field(min_length=1, max_length=MAX_OPTIONS)


class RankOut(BaseModel):
    option_id: uuid.UUID
    rank: int


class OwnBallotOut(BaseModel):
    person_id: uuid.UUID
    # Empty until this person has voted.
    ranks: list[RankOut]


class VoterOut(BaseModel):
    person_id: uuid.UUID
    avatar_emoji: str
    color: str


class VotersOut(BaseModel):
    """Who has voted, for the TV's avatar tiles. Never what they ranked."""

    voted: list[VoterOut]


class PresentOut(BaseModel):
    person_id: uuid.UUID
    avatar_emoji: str
    color: str
    # Has a ballot in this night (the same fact as /voters). Never what they ranked.
    voted: bool


class PresenceOut(BaseModel):
    """Who's here tonight (G8): people a phone set to them opened the night or voted for,
    plus anyone with a ballot. Family first, then guests."""

    present: list[PresentOut]


class PlacementOut(BaseModel):
    option_id: uuid.UUID
    place: int
    score: int
    first_places: int


class VotingResultOut(BaseModel):
    winner_option_id: uuid.UUID
    # A 64-bit integer as a string (JS numbers lose precision past 2^53). The reveal
    # animation is cosmetic and replays this stored result.
    tie_seed: str
    # Options level with the winner on points before any tie-break.
    tie_group: list[uuid.UUID]
    tiebreak: Literal["none", "first_places", "head_to_head", "random"]
    ballot_count: int
    placements: list[PlacementOut]


class WinnerOut(BaseModel):
    option_id: uuid.UUID
    movie_id: uuid.UUID
    title: str
    year: int | None
    poster_path: str | None


class NightSummaryOut(BaseModel):
    id: uuid.UUID
    title: str | None
    status: SessionStatus
    created_at: datetime
    revealed_at: datetime | None
    closed_at: datetime | None
    winner: WinnerOut | None
    # How many people voted.
    turnout: int
    # The family's average score; null until ratings open (`tonight`/`closed`).
    rating: RatingSummaryOut | None


# --- Ratings ---------------------------------------------------------------------------


class RatingIn(BaseModel):
    """One person's score for the night's movie, replacing any earlier one."""

    person_id: uuid.UUID
    score: int = Field(ge=1, le=5)


class OwnRatingOut(BaseModel):
    person_id: uuid.UUID
    # Null until this person has rated.
    score: int | None
    # Took part in the night (present or voted): only then may they rate it (issue #91).
    attended: bool


class RatingSummaryOut(BaseModel):
    """The family's average only: never anyone's own score."""

    # Null while nobody has rated.
    average: float | None
    count: int


# `result` and `rating` refer to models defined below SessionOut / NightSummaryOut.
SessionOut.model_rebuild()
NightSummaryOut.model_rebuild()
