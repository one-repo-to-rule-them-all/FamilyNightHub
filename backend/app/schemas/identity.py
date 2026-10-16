"""Request/response schemas for join, devices and people. The OpenAPI contract."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


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
    # mine: this device can act as them; pending: awaiting host approval;
    # taken: bound to another phone; free: nobody's
    binding: Literal["mine", "pending", "taken", "free"]


class DeviceOut(BaseModel):
    id: uuid.UUID
    people: list[PersonOut]


class MagicLinkIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class MagicLinkOut(BaseModel):
    detail: str


class VerifyIn(BaseModel):
    token: str = Field(min_length=20, max_length=128)


class AccountOut(BaseModel):
    id: uuid.UUID
    email: str
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
