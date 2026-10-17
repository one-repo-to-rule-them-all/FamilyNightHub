"""A person's profile and history (ADR-0014 "Profiles"). Revealed nights only."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class ProfileMovieOut(BaseModel):
    id: uuid.UUID
    title: str
    year: int | None
    poster_path: str | None


class ProfilePickOut(BaseModel):
    option_id: uuid.UUID
    # top3/pick_one: their rank. approval: an ordinal with no meaning (ADR-0010).
    rank: int
    movie: ProfileMovieOut


class ProfileNightOut(BaseModel):
    session_id: uuid.UUID
    title: str | None
    status: Literal["revealed", "tonight", "closed"]
    voting_method: Literal["top3", "approval", "pick_one"]
    date: datetime
    winner: ProfileMovieOut | None
    # Their ballot that night; empty if they only rated or uploaded.
    picks: list[ProfilePickOut]
    # top3/pick_one: the winner was their first choice. approval: they approved it.
    picked_winner: bool
    rating: int | None
    photo_count: int


class ProfileAlbumOut(BaseModel):
    session_id: uuid.UUID
    title: str | None
    photo_count: int
    # The album endpoint (GET; presigned image URLs are minted there, per request).
    photos_url: str


class ProfileStatsOut(BaseModel):
    nights_joined: int
    ballots_cast: int
    winners_picked: int
    ratings_given: int
    average_rating_given: float | None
    photos_uploaded: int


class ProfileOut(BaseModel):
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    created_at: datetime
    stats: ProfileStatsOut
    # Newest first.
    nights: list[ProfileNightOut]
    albums: list[ProfileAlbumOut]
