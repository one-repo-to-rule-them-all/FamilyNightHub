"""Request/response schemas for /api/v1/platform (ADR-0016)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class PlatformLoginIn(BaseModel):
    username_or_email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=256)


class PlatformMeOut(BaseModel):
    """The operator, and the household they're inside, if any."""

    account_id: uuid.UUID
    email: str
    display_name: str
    entered_household_id: uuid.UUID | None
    entered_household_name: str | None
    expires_at: datetime


class PlatformHouseholdOut(BaseModel):
    """ADR-0017 §6: metadata and counts only."""

    id: uuid.UUID
    name: str
    created_at: datetime
    disabled_at: datetime | None
    delete_after: datetime | None
    people: int
    devices: int
    nights: int
    photos: int
    last_activity: datetime | None


class PlatformHouseholdIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    admin_email: str = Field(min_length=3, max_length=320)
    admin_name: str = Field(min_length=1, max_length=80)


class PlatformDisableIn(BaseModel):
    """Why, in words the household's admins are emailed."""

    reason: str = Field(min_length=1, max_length=500)
