"""Request/response schemas for the admin area: people, devices, household settings."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, field_validator

_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_REGION = re.compile(r"^[A-Za-z]{2}$")
_EMOJI_MAX_CODEPOINTS = 16  # people.avatar_emoji is varchar(16); ZWJ families fit
MAX_STREAMING_PROVIDERS = 20


def clean_name(value: str) -> str:
    """Trim and collapse inner whitespace, so "  Sam   B " and "Sam B" are one name."""
    name = " ".join(value.split())
    if not name:
        raise ValueError("name must not be blank")
    if len(name) > 60:
        raise ValueError("name must be at most 60 characters")
    return name


def clean_emoji(value: str) -> str:
    """A short emoji, not a word: no whitespace and at least one non-ASCII character.
    Keycaps like 1️⃣ contain an ASCII digit, so ASCII is allowed alongside emoji."""
    emoji = value.strip()
    if not emoji or len(emoji) > _EMOJI_MAX_CODEPOINTS:
        raise ValueError("avatar_emoji must be 1-16 characters")
    if any(ch.isspace() for ch in emoji) or emoji.isascii():
        raise ValueError("avatar_emoji must be an emoji")
    return emoji


def clean_color(value: str) -> str:
    if not _COLOR.match(value):
        raise ValueError("color must be #rrggbb")
    return value.lower()


# --- People -----------------------------------------------------------------------


Name = Annotated[str, AfterValidator(clean_name)]
Emoji = Annotated[str, AfterValidator(clean_emoji)]
Color = Annotated[str, AfterValidator(clean_color)]


class PersonCreateIn(BaseModel):
    name: Name
    avatar_emoji: Emoji
    color: Color
    # Hosts (sessions:run) may only create guests; members need admin:people.
    is_guest: bool = False


class PersonUpdateIn(BaseModel):
    """Only the fields sent are changed."""

    name: Name | None = None
    avatar_emoji: Emoji | None = None
    color: Color | None = None


class MergeIn(BaseModel):
    from_person_id: uuid.UUID
    into_person_id: uuid.UUID


class AdminPersonOut(BaseModel):
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    created_at: datetime


class MergeOut(BaseModel):
    """What moved. `dropped_*` rows collided with the target's own and were discarded."""

    person: AdminPersonOut
    merged_from_id: uuid.UUID
    ballot_ranks_moved: int
    ballot_ranks_dropped: int
    ratings_moved: int
    ratings_dropped: int
    photos_moved: int
    reactions_moved: int
    reactions_dropped: int
    bindings_moved: int
    bindings_dropped: int


# --- Devices ----------------------------------------------------------------------


class DeviceBindingOut(BaseModel):
    person_id: uuid.UUID
    name: str
    avatar_emoji: str
    status: Literal["active", "pending"]


class AdminDeviceOut(BaseModel):
    id: uuid.UUID
    label: str | None
    is_tv: bool
    last_seen_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    people: list[DeviceBindingOut]


class DeviceUpdateIn(BaseModel):
    # null clears the label
    label: str | None = Field(max_length=80)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        if v is None:
            return None
        label = " ".join(v.split())
        return label or None


# --- Household settings -----------------------------------------------------------

AgeCap = Literal["G", "PG", "PG-13", "R", "NC-17"]


class SettingsOut(BaseModel):
    join_slug: str
    default_voting_method: Literal["top3", "approval", "pick_one"]
    default_age_cap: AgeCap | None
    region: str
    # TMDB watch-provider ids of the household's subscriptions (GET /tmdb/providers).
    streaming_providers: list[int]
    updated_at: datetime


class SettingsUpdateIn(BaseModel):
    """Only the fields sent are changed; `default_age_cap: null` clears the cap."""

    # Phase 1 ships top-3 only (ADR-0006); approval and pick-one land in Phase 2.
    default_voting_method: Literal["top3"] | None = None
    default_age_cap: AgeCap | None = None
    region: str | None = None
    # Replaces the whole list; [] means no streaming services.
    streaming_providers: list[Annotated[int, Field(gt=0)]] | None = Field(
        default=None, max_length=MAX_STREAMING_PROVIDERS
    )

    @field_validator("streaming_providers")
    @classmethod
    def _providers(cls, v: list[int] | None) -> list[int] | None:
        return None if v is None else sorted(set(v))

    @field_validator("region")
    @classmethod
    def _region(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not _REGION.match(v):
            raise ValueError("region must be an ISO 3166-1 alpha-2 code, e.g. US")
        return v.upper()


class JoinSlugOut(BaseModel):
    join_slug: str
