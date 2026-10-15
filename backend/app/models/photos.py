"""Photo album, reactions and the delete tombstone (ADR-0005)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, household_fk, scoped_fk, uuid_pk


class Photo(Base):
    __tablename__ = "photos"
    __table_args__ = (
        UniqueConstraint("id", "household_id"),
        CheckConstraint("status IN ('pending', 'ready', 'hidden')", name="status"),
        CheckConstraint("bytes IS NULL OR bytes BETWEEN 1 AND 10485760", name="bytes"),
        # Photos are hard-deleted only by admins through the service (storage first), so a
        # session or person delete must never silently orphan objects.
        scoped_fk("session_id", "sessions"),
        scoped_fk("person_id", "people"),
        scoped_fk("uploaded_by_device_id", "devices"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    uploaded_by_device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    object_key: Mapped[str] = mapped_column(String(300), unique=True)
    thumb_key: Mapped[str] = mapped_column(String(300), unique=True)
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    bytes: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    backed_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class PhotoReaction(Base):
    __tablename__ = "photo_reactions"
    __table_args__ = (
        UniqueConstraint("photo_id", "person_id", "emoji"),
        scoped_fk("photo_id", "photos", ondelete="CASCADE"),
        scoped_fk("person_id", "people"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    photo_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    emoji: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = created_at()


class PhotoDeletion(Base):
    """Tombstone written in the same transaction as a hard delete, so the worker's
    `propagate_photo_deletes` still knows which backup objects to remove (06)."""

    __tablename__ = "photo_deletions"

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    photo_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True)
    object_key: Mapped[str] = mapped_column(String(300))
    thumb_key: Mapped[str] = mapped_column(String(300))
    deleted_at: Mapped[datetime] = created_at()
    backup_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
