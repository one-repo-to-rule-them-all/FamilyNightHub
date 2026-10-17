"""ORM models. Every model module is imported here so Alembic sees the full metadata."""

from app.models.base import Base
from app.models.household import (
    Account,
    Device,
    DevicePerson,
    Household,
    HouseholdSettings,
    MagicLink,
    Person,
    PinResetRequest,
)
from app.models.movie_night import (
    BallotRank,
    Movie,
    Option,
    Rating,
    Session,
    SessionAttendance,
)
from app.models.ops import AuditEvent, BackupRun, FailedJob, TmdbCache
from app.models.photos import Photo, PhotoDeletion, PhotoReaction

__all__ = [
    "Account",
    "AuditEvent",
    "BackupRun",
    "BallotRank",
    "Base",
    "Device",
    "DevicePerson",
    "FailedJob",
    "Household",
    "HouseholdSettings",
    "MagicLink",
    "Movie",
    "Option",
    "Person",
    "Photo",
    "PhotoDeletion",
    "PhotoReaction",
    "PinResetRequest",
    "Rating",
    "Session",
    "SessionAttendance",
    "TmdbCache",
]
