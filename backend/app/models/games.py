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
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, household_fk, scoped_fk, uuid_pk

GAME_KINDS = ("gratitude_jar", "bingo", "scattergories")
GAME_STATUSES = ("draft", "open", "live", "ended")


class Game(Base):
    __tablename__ = "games"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        CheckConstraint("kind IN ('gratitude_jar', 'bingo', 'scattergories')", name="kind"),
        CheckConstraint("status IN ('draft', 'open', 'live', 'ended')", name="status"),
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
