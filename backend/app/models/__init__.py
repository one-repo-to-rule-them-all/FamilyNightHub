"""ORM models. Every model module is imported here so Alembic sees the full metadata."""

from app.models.base import Base
from app.models.games import (
    BingoCall,
    Game,
    GamePlayer,
    GratitudeNote,
    HouseholdTvTarget,
    ScatterAnswer,
    ScatterRound,
)
from app.models.household import (
    Account,
    Device,
    DevicePerson,
    Household,
    HouseholdConsent,
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
from app.models.ops import (
    AuditEvent,
    BackupRun,
    FailedJob,
    PlatformAuditEvent,
    PlatformOperator,
    TmdbCache,
)
from app.models.photos import Photo, PhotoDeletion, PhotoReaction

__all__ = [
    "HouseholdTvTarget",
    "Account",
    "AuditEvent",
    "BackupRun",
    "BallotRank",
    "Base",
    "Device",
    "DevicePerson",
    "FailedJob",
    "Game",
    "GamePlayer",
    "ScatterAnswer",
    "ScatterRound",
    "BingoCall",
    "GratitudeNote",
    "Household",
    "HouseholdConsent",
    "HouseholdSettings",
    "MagicLink",
    "Movie",
    "Option",
    "Person",
    "Photo",
    "PhotoDeletion",
    "PhotoReaction",
    "PinResetRequest",
    "PlatformAuditEvent",
    "PlatformOperator",
    "Rating",
    "Session",
    "SessionAttendance",
    "TmdbCache",
]
