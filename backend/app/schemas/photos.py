"""Request/response schemas for the night's photo album (ADR-0005). The OpenAPI contract.

Every URL here is a short-lived presigned URL into the private bucket; none is stable and
none should be stored or shared.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

PhotoStatus = Literal["ready", "hidden"]
# Mirrors photo_service.REACTIONS (pinned by a unit test).
Reaction = Literal["❤️", "😂", "😮", "👍", "🎉", "🍿"]


class PhotoCreateIn(BaseModel):
    person_id: uuid.UUID = Field(description="Who is sharing it: a person bound to this device")
    taken_on: date | None = Field(
        default=None, description="EXIF DateTimeOriginal, date only (read on the phone)"
    )


class PhotoCreatedOut(BaseModel):
    photo_id: uuid.UUID
    upload_url: str = Field(description="PUT the full JPEG here with Content-Type: image/jpeg")
    thumb_upload_url: str = Field(description="PUT the thumbnail JPEG here, same content type")
    expires_in: int = Field(description="Seconds the upload URLs stay valid")


class ReactionCountOut(BaseModel):
    emoji: str
    count: int


class MyReactionOut(BaseModel):
    person_id: uuid.UUID
    emoji: str


class PhotoOut(BaseModel):
    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    person_avatar_emoji: str
    person_color: str
    status: PhotoStatus
    taken_on: date | None
    created_at: datetime
    url: str = Field(description="Presigned GET for the full image (10 min)")
    thumb_url: str = Field(description="Presigned GET for the thumbnail (10 min)")
    reactions: list[ReactionCountOut]
    my_reactions: list[MyReactionOut] = Field(
        description="Reactions by people bound to the calling device (empty for accounts)"
    )
