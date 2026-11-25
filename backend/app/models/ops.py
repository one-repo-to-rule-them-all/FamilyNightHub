"""Audit trail (household-scoped) and the global operational tables.

Global tables hold no household data by design: they are readable by `fnh_app` without a
GUC, so `test_rls_coverage` keeps an explicit allowlist of them.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, household_fk, uuid_pk


class AuditEvent(Base):
    """Who did what. Actor ids are plain uuids (no FK) so history survives device cleanup."""

    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = uuid_pk()
    household_id: Mapped[uuid.UUID] = household_fk()
    actor_account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    created_at: Mapped[datetime] = created_at()


class TmdbCache(Base):
    """Global: TMDB responses are not household data. Refreshed at <= 30 days (06)."""

    __tablename__ = "tmdb_cache"

    cache_key: Mapped[str] = mapped_column(String(300), primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    fetched_at: Mapped[datetime] = created_at()


class FailedJob(Base):
    """Global dead-letter record (FieldPro pattern). Never store job args: they can carry
    household ids or names. The error text is a truncated exception summary."""

    __tablename__ = "failed_jobs"

    id: Mapped[uuid.UUID] = uuid_pk()
    job_name: Mapped[str] = mapped_column(String(100))
    job_id: Mapped[str] = mapped_column(String(100))
    job_try: Mapped[int] = mapped_column(Integer)
    error: Mapped[str] = mapped_column(Text)
    failed_at: Mapped[datetime] = created_at()


class BackupRun(Base):
    """Global: one row per backup run across all households (06, admin home page)."""

    __tablename__ = "backup_runs"
    __table_args__ = (CheckConstraint("kind IN ('photos', 'pg_dump')", name="kind"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    kind: Mapped[str] = mapped_column(String(16))
    started_at: Mapped[datetime] = created_at()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    objects_copied: Mapped[int] = mapped_column(Integer, server_default="0")
    bytes_copied: Mapped[int] = mapped_column(BigInteger, server_default="0")
    errors: Mapped[int] = mapped_column(Integer, server_default="0")


class PlatformOperator(Base):
    """ADR-0016: who may sign in to /platform. Global (no household data). fnh_app can only
    read it; `python -m app.cli grant-platform` writes it as the owner."""

    __tablename__ = "platform_operators"

    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    granted_at: Mapped[datetime] = created_at()
    granted_by: Mapped[str] = mapped_column(String(120))


class PlatformAuditEvent(Base):
    """ADR-0016 §6: every platform action. Global; `household_ref` is a bare id, not a
    household scope. fnh_app may insert and read, never edit."""

    __tablename__ = "platform_audit_events"

    id: Mapped[uuid.UUID] = uuid_pk()
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    household_ref: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    action: Mapped[str] = mapped_column(String(64))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    created_at: Mapped[datetime] = created_at()
