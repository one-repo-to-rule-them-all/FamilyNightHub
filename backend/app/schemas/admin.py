"""Request/response schemas for the admin area: people, devices, household settings."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, field_validator

from app.domain import credentials

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
    # ADR-0014: whether they have set a PIN, and whether 5 wrong PINs locked them.
    has_pin: bool
    locked: bool


class RemovalOut(BaseModel):
    """What removing a person deletes (issue #94): shown in the confirm dialog, and returned
    by the delete."""

    nights_voted: int
    ratings: int
    photos: int
    reactions: int
    phones: int


class StartFreshIn(BaseModel):
    confirm_name: Annotated[str, Field(min_length=1, max_length=120)]


class StartFreshOut(BaseModel):
    people: int
    phones: int
    nights: int
    photos: int


class PinResetOut(BaseModel):
    """A "forgot PIN" request. Approving clears the PIN; no PIN is ever shown or chosen."""

    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    avatar_emoji: str
    person_locked: bool
    requested_by_device_id: uuid.UUID
    device_label: str | None
    status: Literal["open", "approved", "dismissed"]
    requested_at: datetime
    resolved_at: datetime | None


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
    # Not revoked, but unused for DEVICE_IDLE_DAYS: it must enter a night code again.
    expired: bool
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
    # The TV's join QR carries the night code (`/j/{slug}?code=`). Default off.
    qr_includes_night_code: bool


class SettingsUpdateIn(BaseModel):
    """Only the fields sent are changed; `default_age_cap: null` clears the cap."""

    # Any method (ADR-0006, ADR-0010); a new night starts with it.
    default_voting_method: Literal["top3", "approval", "pick_one"] | None = None
    default_age_cap: AgeCap | None = None
    region: str | None = None
    # Replaces the whole list; [] means no streaming services.
    streaming_providers: list[Annotated[int, Field(gt=0)]] | None = Field(
        default=None, max_length=MAX_STREAMING_PROVIDERS
    )
    qr_includes_night_code: bool | None = None

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


class HelpCountOut(BaseModel):
    """The TV's "waiting for the host" nudge (G4): pending person claims only."""

    count: int
    # First name of the person in the oldest waiting claim; null when count is 0.
    first_name: str | None


class PinResetCountOut(BaseModel):
    """The admin nav badge (G4)."""

    open_count: int


class JoinLinkOut(BaseModel):
    """What the TV needs to draw its join QR: `/j/{join_slug}`, plus `?code={code}` when
    `qr_includes_night_code` is on. The night code is never here: the server only keeps its
    hash (ADR-0002), and the TV already holds the plaintext from create/rotate."""

    join_slug: str
    qr_includes_night_code: bool


# --- Accounts (issue #71) -----------------------------------------------------------


AccountRole = Literal["admin", "host"]
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def clean_email(value: str) -> str:
    """Trimmed and lowercased: accounts.email is unique case-insensitively."""
    email = value.strip().lower()
    if not _EMAIL.match(email):
        raise ValueError("email does not look like an email address")
    return email


def clean_display_name(value: str) -> str:
    name = " ".join(value.split())
    if not name:
        raise ValueError("name must not be blank")
    if len(name) > 80:
        raise ValueError("name must be at most 80 characters")
    return name


class AccountInviteIn(BaseModel):
    """Invite an adult by email. They choose their own password from the emailed link."""

    email: Annotated[str, AfterValidator(clean_email)] = Field(max_length=320)
    display_name: Annotated[str, AfterValidator(clean_display_name)] = Field(max_length=200)
    role: AccountRole
    username: str | None = Field(default=None, max_length=64)

    @field_validator("username")
    @classmethod
    def _username(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return credentials.normalize_username(value)


class AccountRoleIn(BaseModel):
    role: AccountRole


class AdminAccountOut(BaseModel):
    """A host or admin as other admins see it. Never carries a password, hash or link."""

    id: uuid.UUID
    email: str
    username: str | None
    display_name: str
    role: AccountRole
    # active: has set a password. invited: hasn't yet (a pending invite, or a CLI bootstrap).
    status: Literal["active", "invited"]
    is_you: bool
    # The newest unused invite/reset link's expiry while `invited`, else null.
    invite_expires_at: datetime | None
    created_at: datetime
