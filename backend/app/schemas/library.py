"""Request/response schemas for the movie library and history admin (Phase 2)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field

from app.schemas.sessions import TmdbResultOut

MAX_BULK_LINES = 100


def _clean_title(value: str) -> str:
    title = " ".join(value.split())
    if not title:
        raise ValueError("title must not be blank")
    return title


def _clean_reason(value: str) -> str:
    reason = " ".join(value.split())
    if not reason:
        raise ValueError("reason must not be blank")
    return reason


Title = Annotated[str, Field(max_length=300), AfterValidator(_clean_title)]
Year = Annotated[int, Field(ge=1870, le=2100)]


class AdminMovieOut(BaseModel):
    id: uuid.UUID
    tmdb_id: int | None
    title: str
    year: int | None
    poster_path: str | None
    owned: bool
    watchlist: bool
    blocked: bool
    created_at: datetime


class MoviePageOut(BaseModel):
    items: list[AdminMovieOut]
    total: int
    limit: int
    offset: int


class MovieFlagsIn(BaseModel):
    """Only the flags sent are changed."""

    owned: bool | None = None
    watchlist: bool | None = None
    blocked: bool | None = None


class TypedTitleIn(BaseModel):
    title: Title
    year: Year | None = None


class BulkAddIn(BaseModel):
    """Typed titles, one per line in the UI ("Title (year)" parsed client-side)."""

    titles: list[TypedTitleIn] = Field(min_length=1, max_length=MAX_BULK_LINES)


class BulkPickIn(BaseModel):
    """An answer for an ambiguous or not-found line: `tmdb_id` to use that TMDB title, or
    leave it out to add the title as typed (no TMDB id)."""

    title: Title
    year: Year | None = None
    tmdb_id: int | None = Field(default=None, ge=1)


class BulkConfirmIn(BaseModel):
    picks: list[BulkPickIn] = Field(min_length=1, max_length=MAX_BULK_LINES)


class BulkLineOut(BaseModel):
    title: str
    year: int | None
    status: Literal["matched", "ambiguous", "not_found", "added_manual"]
    # Set for matched / added_manual: the library row, now owned.
    movie: AdminMovieOut | None
    already_owned: bool
    # Set for ambiguous: TMDB's top candidates, best first.
    candidates: list[TmdbResultOut]


class BulkResultOut(BaseModel):
    lines: list[BulkLineOut]
    # TMDB was off or down: lines from that point on were added as typed titles.
    tmdb_unavailable: bool
    attribution: str


class CorrectWinnerIn(BaseModel):
    option_id: uuid.UUID
    reason: Annotated[str, Field(max_length=500), AfterValidator(_clean_reason)]
