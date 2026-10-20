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
    """Admin/host logins: username or email + password (ADR-0014); the magic link only resets
    the password. Email and username are unique across households so login is unambiguous."""

    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        CheckConstraint("role IN ('admin', 'host')", name="role"),
        CheckConstraint("username ~ '^[a-z0-9._-]{3,32}$'", name="username"),
        Index("uq_accounts_email_lower", text("lower(email)"), unique=True),
        Index("uq_accounts_username_lower", text("lower(username)"), unique=True),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    email: Mapped[str] = mapped_column(String(320))
    display_name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(16))
    username: Mapped[str | None] = mapped_column(String(32))
    # argon2id (ADR-0014). NULL until the account sets a password.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
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
    # ADR-0014: argon2id over the peppered PIN. NULL until set (or after an admin reset).
    pin_hash: Mapped[str | None] = mapped_column(String(255))
    pin_set_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pin_failed_attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    # Set at the 5th wrong PIN; only an admin-approved reset clears it.
    pin_locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Rename-once from the person's own phone; admin renames don't set it.
    name_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
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
    """Which people a device may act as. `pending` = awaiting host approval (ADR-0002, now
    the override for claims without a PIN, ADR-0014). `is_current` = the one person this
    device is acting as right now; switching needs that person's PIN."""

    __tablename__ = "device_people"
    __table_args__ = (
        UniqueConstraint("device_id", "person_id"),
        CheckConstraint("status IN ('active', 'pending')", name="status"),
        scoped_fk("device_id", "devices", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
        Index(
            "uq_device_people_current",
            "device_id",
            unique=True,
            postgresql_where=text("is_current"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    is_current: Mapped[bool] = mapped_column(Boolean, server_default="false")
    created_at: Mapped[datetime] = created_at()


class PinResetRequest(Base):
    """Forgot-PIN requests (ADR-0014): one open request per person; an admin approves (clears the
    PIN and the lock) or dismisses it. Never holds a PIN."""

    __tablename__ = "pin_reset_requests"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'approved', 'dismissed')", name="status"),
        CheckConstraint("(status = 'open') = (resolved_at IS NULL)", name="resolved_when_closed"),
        scoped_fk("person_id", "people"),
        scoped_fk("requested_by_device_id", "devices"),
        scoped_fk("resolved_by_account_id", "accounts"),
        Index(
            "uq_pin_reset_requests_open",
            "person_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    requested_by_device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(16), server_default="open")
    created_at: Mapped[datetime] = created_at()
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class HouseholdConsent(Base):
    """ADR-0017 §2: one row per acceptance of the Terms and Privacy Policy. Append-only: a new
    version or a correction is a new row. The household's gate is open while some admin row
    with `guardian` names the current versions."""

    __tablename__ = "household_consents"
    __table_args__ = (
        CheckConstraint("role IN ('admin', 'host')", name="role"),
        scoped_fk("account_id", "accounts"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    # The role at acceptance: only an admin's consent opens the household's gate.
    role: Mapped[str] = mapped_column(String(16))
    terms_version: Mapped[str] = mapped_column(String(32))
    privacy_version: Mapped[str] = mapped_column(String(32))
    # "I am a parent or legal guardian of the children I add." Admins only.
    guardian: Mapped[bool] = mapped_column(Boolean, server_default="false")
    accepted_at: Mapped[datetime] = created_at()


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
    # ADR-0014 / owner: the TV's join QR may include the night code (the TV appends it).
    qr_includes_night_code: Mapped[bool] = mapped_column(Boolean, server_default="false")
    updated_at: Mapped[datetime] = created_at()
