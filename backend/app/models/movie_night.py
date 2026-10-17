"""Movies, sessions (nights), shortlist options, ballots and ratings (ADR-0006)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, household_fk, scoped_fk, uuid_pk

SESSION_STATUSES = ("draft", "voting", "revealed", "tonight", "closed")


class Movie(Base):
    __tablename__ = "movies"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        Index(
            "uq_movies_household_tmdb",
            "household_id",
            "tmdb_id",
            unique=True,
            postgresql_where=text("tmdb_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    tmdb_id: Mapped[int | None] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300))
    year: Mapped[int | None] = mapped_column(SmallInteger)
    poster_path: Mapped[str | None] = mapped_column(String(200))
    genres: Mapped[list[str]] = mapped_column(ARRAY(String(40)), server_default="{}")
    runtime: Mapped[int | None] = mapped_column(SmallInteger)
    us_cert: Mapped[str | None] = mapped_column(String(8))
    owned: Mapped[bool] = mapped_column(Boolean, server_default="false")
    watchlist: Mapped[bool] = mapped_column(Boolean, server_default="false")
    blocked: Mapped[bool] = mapped_column(Boolean, server_default="false")
    created_at: Mapped[datetime] = created_at()


class Session(Base):
    """One night: draft -> voting -> revealed -> tonight -> closed (03-backend.md).

    `revealed -> tonight` is lazy: the snapshot treats a session as `tonight` once
    `revealed_at` is 30s old, and the next write persists it (no timer job).
    """

    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        CheckConstraint(
            "status IN ('draft', 'voting', 'revealed', 'tonight', 'closed')", name="status"
        ),
        CheckConstraint("voting_method IN ('top3', 'approval', 'pick_one')", name="voting_method"),
        # 1..8 since ADR-0010: approval may hold the whole shortlist.
        CheckConstraint("ballot_size BETWEEN 1 AND 8", name="ballot_size"),
        # The host's slideshow control: started, stopped, or neither (auto). Never both.
        CheckConstraint(
            "num_nonnulls(slideshow_started_at, slideshow_stopped_at) <= 1",
            name="slideshow_one_state",
        ),
        scoped_fk("host_account_id", "accounts"),
        # The winner must be one of this session's own options (05-data.md).
        ForeignKeyConstraint(
            ["winner_option_id", "id"],
            ["options.id", "options.session_id"],
            use_alter=True,
            name="fk_sessions_winner_option",
        ),
        # A night code identifies one live night per household; closed nights release it.
        Index(
            "uq_sessions_live_night_code",
            "household_id",
            "night_code_hash",
            unique=True,
            postgresql_where=text("status <> 'closed'"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    title: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(16), server_default="draft")
    voting_method: Mapped[str] = mapped_column(String(16), server_default="top3")
    ballot_size: Mapped[int] = mapped_column(SmallInteger, server_default="3")
    night_code_hash: Mapped[str] = mapped_column(String(64))
    age_cap: Mapped[str | None] = mapped_column(String(8))
    host_account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    ranking: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # secrets.randbits(64) exceeds bigint's signed range, hence numeric(20) (ADR-0006).
    tie_seed: Mapped[Decimal | None] = mapped_column(Numeric(20, 0))
    winner_option_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()
    voting_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Host's Start/Stop for the TV slideshow (issue #41); both null = auto.
    slideshow_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    slideshow_stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Option(Base):
    __tablename__ = "options"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        UniqueConstraint("id", "session_id"),
        UniqueConstraint("session_id", "movie_id"),
        CheckConstraint("source IN ('manual', 'owned', 'streaming', 'tmdb')", name="source"),
        scoped_fk("session_id", "sessions", ondelete="CASCADE"),
        scoped_fk("movie_id", "movies"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    movie_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    source: Mapped[str] = mapped_column(String(16), server_default="manual")
    position: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    created_at: Mapped[datetime] = created_at()


class BallotRank(Base):
    """One row per (person, rank). Replaced wholesale on each submit until close. For
    approval the rank is a 1..m ordinal of the approvals with no meaning (ADR-0010);
    the per-method limit (top3 <= 3) is enforced in domain/voting, not here."""

    __tablename__ = "ballot_ranks"
    __table_args__ = (
        UniqueConstraint("session_id", "person_id", "rank"),
        UniqueConstraint("session_id", "person_id", "option_id"),
        CheckConstraint("rank BETWEEN 1 AND 8", name="rank"),
        CheckConstraint(
            "cast_by_device_id IS NOT NULL OR cast_by_account_id IS NOT NULL", name="cast_by"
        ),
        scoped_fk("session_id", "sessions", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
        scoped_fk("cast_by_device_id", "devices"),
        scoped_fk("cast_by_account_id", "accounts"),
        # The option must belong to the same session as the ballot.
        ForeignKeyConstraint(
            ["option_id", "session_id"], ["options.id", "options.session_id"], ondelete="CASCADE"
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    option_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    rank: Mapped[int] = mapped_column(SmallInteger)
    cast_by_device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    cast_by_account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    is_proxy: Mapped[bool] = mapped_column(Boolean, server_default="false")
    created_at: Mapped[datetime] = created_at()


class Rating(Base):
    """Table ships in Phase 1; the rating prompt UI is Phase 2 (BUILD-PROMPT.md)."""

    __tablename__ = "ratings"
    __table_args__ = (
        UniqueConstraint("session_id", "person_id"),
        CheckConstraint("score BETWEEN 1 AND 5", name="score"),
        scoped_fk("session_id", "sessions", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    score: Mapped[int] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = created_at()


class SessionAttendance(Base):
    """Who is here tonight (guest-flow G8): first time a phone acting as the person opened
    the night or voted. Read with the ballots by GET /sessions/{id}/present."""

    __tablename__ = "session_attendance"
    __table_args__ = (
        UniqueConstraint("session_id", "person_id"),
        scoped_fk("session_id", "sessions", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    first_seen_at: Mapped[datetime] = created_at()
