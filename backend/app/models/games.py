"""Games (ADR-0018): a game row per jar/bingo round/scattergories game, its roster and the
Gratitude Jar's notes. Household-scoped like every domain table (ADR-0003)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, household_fk, scoped_fk, uuid_pk

GAME_KINDS = ("gratitude_jar", "bingo", "scattergories", "loteria")
GAME_STATUSES = ("draft", "open", "live", "ended")


class Game(Base):
    __tablename__ = "games"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        CheckConstraint(
            "kind IN ('gratitude_jar', 'bingo', 'scattergories', 'loteria')", name="kind"
        ),
        CheckConstraint("status IN ('draft', 'open', 'live', 'ended')", name="status"),
        CheckConstraint(
            "cycle_paused_index IS NULL OR cycle_paused_index >= 0", name="cycle_paused_index"
        ),
        scoped_fk("created_by_account_id", "accounts"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(10))
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"), default=dict
    )
    created_by_account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    reveal_seed: Mapped[Decimal | None] = mapped_column(Numeric(20, 0))
    created_at: Mapped[datetime] = created_at()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Gratitude Jar auto-cycle (ADR-0018 amendment B); null for other games and manual jars.
    cycle_anchor_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cycle_paused_index: Mapped[int | None] = mapped_column(Integer)


class GamePlayer(Base):
    __tablename__ = "game_players"
    __table_args__ = (
        UniqueConstraint("game_id", "person_id"),
        scoped_fk("game_id", "games", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    game_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class GratitudeNote(Base):
    __tablename__ = "gratitude_notes"
    __table_args__ = (
        UniqueConstraint("game_id", "reveal_position"),
        CheckConstraint("char_length(body) BETWEEN 1 AND 280", name="body_length"),
        scoped_fk("game_id", "games", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    game_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    body: Mapped[str] = mapped_column(String(280))
    anonymous: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), default=False)
    reveal_position: Mapped[int | None] = mapped_column(Integer)
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class BingoCard(Base):
    __tablename__ = "bingo_cards"
    __table_args__ = (
        UniqueConstraint("game_id", "person_id"),
        CheckConstraint("cardinality(squares) IN (16, 25)", name="squares_count"),
        CheckConstraint("marked_mask BETWEEN 0 AND 33554431", name="marked_mask_range"),
        scoped_fk("game_id", "games", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    game_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    squares: Mapped[list[str]] = mapped_column(ARRAY(String(80)))
    marked_mask: Mapped[int] = mapped_column(Integer, server_default=text("0"), default=0)
    won_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class BingoCall(Base):
    """One number called in a classic bingo game. No person column: it goes with its game."""

    __tablename__ = "bingo_calls"
    __table_args__ = (
        UniqueConstraint("game_id", "seq"),
        UniqueConstraint("game_id", "value"),
        CheckConstraint("value BETWEEN 1 AND 75", name="value_range"),
        CheckConstraint("seq >= 0", name="seq_nonneg"),
        scoped_fk("game_id", "games", ondelete="CASCADE"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    game_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    seq: Mapped[int] = mapped_column(SmallInteger)
    value: Mapped[int] = mapped_column(SmallInteger)
    called_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class ScatterRound(Base):
    """One round of a scattergories game. `ends_at` is the server clock for the round;
    the effective state (running, closed, revealed) is derived from it on read."""

    __tablename__ = "scatter_rounds"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        UniqueConstraint("game_id", "round_no"),
        CheckConstraint("round_no >= 1", name="round_no"),
        CheckConstraint("duration_seconds BETWEEN 10 AND 900", name="duration"),
        scoped_fk("game_id", "games", ondelete="CASCADE"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    game_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    round_no: Mapped[int] = mapped_column(Integer)
    letter: Mapped[str] = mapped_column(String(1))
    categories: Mapped[list[str]] = mapped_column(JSONB)
    duration_seconds: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ScatterAnswer(Base):
    """A person's answer in one category. Scores are derived from these, never stored."""

    __tablename__ = "scatter_answers"
    __table_args__ = (
        UniqueConstraint("round_id", "person_id", "category_index"),
        CheckConstraint("category_index >= 0", name="category_index"),
        CheckConstraint("char_length(text) BETWEEN 1 AND 60", name="text_length"),
        CheckConstraint("host_verdict IN ('accepted', 'rejected')", name="verdict"),
        scoped_fk("round_id", "scatter_rounds", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    round_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    category_index: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(String(60))
    host_verdict: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sql_text("now()")
    )


class HouseholdTvTarget(Base):
    """The game a host sent to the household's paired TV (ADR-0018 amendment). At most one row."""

    __tablename__ = "household_tv_target"
    __table_args__ = (scoped_fk("game_id", "games", ondelete="CASCADE"),)

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    set_by_account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sql_text("now()")
    )
