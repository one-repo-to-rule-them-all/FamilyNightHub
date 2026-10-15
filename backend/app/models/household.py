"""Households, identities and settings (ADR-0002, ADR-0003)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, household_fk, scoped_fk, uuid_pk


class Household(Base):
    """RLS root: visible only when `id` matches the GUC. Slug lookup goes via ADR-0009."""

    __tablename__ = "households"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120))
    # Rotatable (ADR-0002): rotating invalidates the printed fridge QR.
    join_slug: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = created_at()


class Account(Base):
    """Admin/host logins (magic link). Email is unique across households so login is unambiguous."""

    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        CheckConstraint("role IN ('admin', 'host')", name="role"),
        Index("uq_accounts_email_lower", text("lower(email)"), unique=True),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    email: Mapped[str] = mapped_column(String(320))
    display_name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(16))
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class MagicLink(Base):
    __tablename__ = "magic_links"
    __table_args__ = (scoped_fk("account_id", "accounts", ondelete="CASCADE"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class Person(Base):
    """Family members and guests. Merged, never deleted (05-data.md)."""

    __tablename__ = "people"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        scoped_fk("merged_into_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    name: Mapped[str] = mapped_column(String(60))
    avatar_emoji: Mapped[str] = mapped_column(String(16))
    color: Mapped[str] = mapped_column(String(16))
    is_guest: Mapped[bool] = mapped_column(Boolean, server_default="false")
    merged_into_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()


class Device(Base):
    """A phone or TV holding an `fnh_device` cookie; only the peppered hash is stored."""

    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("id", "household_id"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str | None] = mapped_column(String(80))
    is_tv: Mapped[bool] = mapped_column(Boolean, server_default="false")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class DevicePerson(Base):
    """Which people a device may act as. `pending` = claimed a person bound elsewhere,
    awaiting host approval (ADR-0002)."""

    __tablename__ = "device_people"
    __table_args__ = (
        UniqueConstraint("device_id", "person_id"),
        CheckConstraint("status IN ('active', 'pending')", name="status"),
        scoped_fk("device_id", "devices", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_at: Mapped[datetime] = created_at()


class HouseholdSettings(Base):
    __tablename__ = "settings"
    __table_args__ = (
        CheckConstraint(
            "default_voting_method IN ('top3', 'approval', 'pick_one')", name="voting_method"
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), primary_key=True
    )
    default_voting_method: Mapped[str] = mapped_column(String(16), server_default="top3")
    default_age_cap: Mapped[str | None] = mapped_column(String(8))
    streaming_providers: Mapped[list[int]] = mapped_column(ARRAY(Integer), server_default="{}")
    region: Mapped[str] = mapped_column(String(2), server_default="US")
    updated_at: Mapped[datetime] = created_at()
