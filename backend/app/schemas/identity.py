"""Request/response schemas for join, devices and people. The OpenAPI contract."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field

from app.domain import credentials
from app.schemas.admin import Color, Emoji, Name


def _password(value: str) -> str:
    """Length and denylist only; "not your own username/email" needs the account and is
    checked by auth_service."""
    return credentials.check_password(value)


Pin = Annotated[str, AfterValidator(credentials.check_pin)]
Password = Annotated[str, AfterValidator(_password)]


class CsrfOut(BaseModel):
    csrf_token: str


class JoinIn(BaseModel):
    slug: str = Field(min_length=1, max_length=64)
    night_code: str = Field(min_length=1, max_length=16)
    device_label: str | None = Field(default=None, max_length=80)


class JoinOut(BaseModel):
    household_name: str
    session_id: uuid.UUID
    device_id: uuid.UUID


class PersonOut(BaseModel):
    id: uuid.UUID
    name: str
    avatar_emoji: str
    color: str
    is_guest: bool
    # mine: bound to this device; pending: awaiting host approval;
    # taken: bound to another phone; free: nobody's
    binding: Literal["mine", "pending", "taken", "free"]
    # ADR-0014. No PIN yet: the next claim (or set-PIN on a phone that holds them) sets it.
    has_pin: bool
    # 5 wrong PINs: every claim refuses until an admin approves a reset.
    locked: bool
    # This phone is acting as them right now (votes, photos, ratings go through this one).
    current: bool
    # May still change their own name once (the current person only).
    can_rename: bool


class DeviceOut(BaseModel):
    id: uuid.UUID
    people: list[PersonOut]


class MagicLinkIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class MagicLinkOut(BaseModel):
    detail: str


class VerifyIn(BaseModel):
    """Forgot password (ADR-0014): the emailed link sets a new password and signs in."""

    token: str = Field(min_length=20, max_length=128)
    new_password: Password


class LoginIn(BaseModel):
    username_or_email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=credentials.PASSWORD_MAX)


class PasswordIn(BaseModel):
    """Required when the account already has a password."""

    current_password: str | None = Field(
        default=None, min_length=1, max_length=credentials.PASSWORD_MAX
    )
    new_password: Password


class AccountOut(BaseModel):
    id: uuid.UUID
    email: str
    username: str | None
    has_password: bool
    display_name: str
    role: Literal["admin", "host"]
    household_name: str


class EnrollIn(BaseModel):
    device_label: str | None = Field(default=None, max_length=80)
    # "Use as TV": marks the device as the TV and signs the host out of this browser.
    as_tv: bool = False


class EnrollOut(BaseModel):
    device_id: uuid.UUID
    is_tv: bool


class ClaimOut(BaseModel):
    device_id: uuid.UUID
    device_label: str | None
    person_id: uuid.UUID
    person_name: str
    avatar_emoji: str
    requested_at: datetime


class BindingOut(BaseModel):
    person_id: uuid.UUID
    status: Literal["active", "pending"]
    # True once this phone is acting as them.
    current: bool


class ClaimIn(BaseModel):
    """Claim a person for this phone or switch to them (ADR-0014). `pin` is their PIN, or
    the new one on a first claim. Leave it out to ask a host to approve instead."""

    pin: Pin | None = None


class SetPinIn(BaseModel):
    new_pin: Pin
    # Required when they already have a PIN.
    current_pin: Pin | None = None


class SelfCreateIn(BaseModel):
    """A new guest profile for whoever holds this phone; the PIN is set in the same call."""

    name: Name
    avatar_emoji: Emoji
    color: Color
    pin: Pin


class RenameSelfIn(BaseModel):
    name: Name


class PinResetRequestOut(BaseModel):
    id: uuid.UUID
    status: Literal["open", "approved", "dismissed"]
    requested_at: datetime


class PinErrorBody(BaseModel):
    code: Literal["wrong_pin", "pin_locked"]
    message: str
    request_id: str | None
    attempts_left: int


class PinErrorOut(BaseModel):
    """403 wrong PIN (counted), 423 locked. Same envelope as every error, plus attempts_left."""

    error: PinErrorBody
