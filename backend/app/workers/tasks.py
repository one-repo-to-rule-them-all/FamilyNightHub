"""ARQ task bodies (06-background-worker.md "Registered tasks").

Every task walks households through `worker_list_household_ids()` (ADR-0009) and does its
work inside `household_session(hid)`, so RLS binds the worker exactly as it binds the API.
Each household gets its own transaction: one household's failure is logged, sent to Sentry
and skipped, the rest still run, and the job then fails as a whole so `after_job_end`
records it in `failed_jobs`. Cron jobs retry on the next tick.

No shared `ctx["db"]` (FieldPro pitfall, see main.py): ARQ runs jobs concurrently and one
AsyncSession cannot serve two of them.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.integrations.email import EmailSender, email_sender, send_safely
from app.integrations.storage import NoopObjectStore, ObjectStore
from app.services import household_deletion_service

log = structlog.get_logger()

HouseholdWork = Callable[[AsyncSession, uuid.UUID], Awaitable[int]]


class HouseholdTaskError(RuntimeError):
    """Raised after the loop when any household failed. The message carries counts only:
    it is persisted in `failed_jobs.error`, which must not hold household data."""


async def list_household_ids() -> list[uuid.UUID]:
    """ADR-0009 resolver: the worker's only cross-household read, ids only."""
    async with AsyncSessionLocal() as session:
        result = await session.scalars(text("SELECT * FROM worker_list_household_ids()"))
        return list(result)


async def for_each_household(task_name: str, work: HouseholdWork) -> int:
    """Run `work` once per household in its own GUC-scoped transaction; return the total."""
    total = 0
    failed = 0
    household_ids = await list_household_ids()
    for hid in household_ids:
        try:
            async with household_session(hid) as session:
                total += await work(session, hid)
        except Exception as exc:
            failed += 1
            log.exception("worker_household_failed", task=task_name, household_id=str(hid))
            if settings.SENTRY_DSN:
                import sentry_sdk

                with sentry_sdk.new_scope() as scope:
                    scope.set_tag("task_name", task_name)
                    scope.set_tag("household_id", str(hid))
                    sentry_sdk.capture_exception(exc)
    if failed:
        raise HouseholdTaskError(f"{task_name}: {failed} of {len(household_ids)} households failed")
    return total


# --------------------------------------------------------------------------- #
# auto_close_stale_sessions (hourly)
# --------------------------------------------------------------------------- #

# `revealed` is included on purpose: revealed -> tonight is lazy (03-backend.md), so a night
# nobody touched after the reveal is still `revealed` in the table while the app shows it
# as `tonight`. Closing and auditing happen in one statement, so either both land or neither.
_CLOSE_STALE = text(
    """
    WITH closed AS (
        UPDATE sessions
        SET status = 'closed', closed_at = now()
        WHERE household_id = :hid
          AND status IN ('revealed', 'tonight')
          AND revealed_at < now() - make_interval(hours => :hours)
        RETURNING id
    )
    INSERT INTO audit_events (household_id, action, target_type, target_id, data)
    SELECT :hid, 'session.auto_closed', 'session', closed.id,
           jsonb_build_object('reason', 'stale', 'after_hours', :hours)
    FROM closed
    RETURNING target_id
    """
)


async def _close_stale(session: AsyncSession, hid: uuid.UUID) -> int:
    result = await session.execute(
        _CLOSE_STALE, {"hid": hid, "hours": settings.STALE_SESSION_HOURS}
    )
    return len(result.all())


async def auto_close_stale_sessions(ctx: dict[str, Any]) -> dict[str, int]:
    closed = await for_each_household("auto_close_stale_sessions", _close_stale)
    log.info("auto_close_stale_sessions_done", closed=closed)
    return {"closed": closed}


# --------------------------------------------------------------------------- #
# sweep_orphan_uploads (hourly)
# --------------------------------------------------------------------------- #

# FOR UPDATE: an upload confirm racing the sweep blocks until this transaction ends and then
# finds the row gone, instead of flipping to `ready` a photo whose objects were just deleted.
_SELECT_ORPHANS = text(
    """
    SELECT id, object_key, thumb_key FROM photos
    WHERE household_id = :hid
      AND status = 'pending'
      AND created_at < now() - make_interval(hours => :hours)
    FOR UPDATE
    """
)
_DELETE_ORPHANS = text(
    "DELETE FROM photos WHERE household_id = :hid AND status = 'pending' AND id = ANY(:ids)"
)


def _sweeper(store: ObjectStore) -> HouseholdWork:
    async def sweep(session: AsyncSession, hid: uuid.UUID) -> int:
        rows = (
            await session.execute(
                _SELECT_ORPHANS, {"hid": hid, "hours": settings.ORPHAN_UPLOAD_HOURS}
            )
        ).all()
        if not rows:
            return 0
        # Storage first: if it fails the rows stay, and the next tick retries both.
        await store.delete_objects([key for r in rows for key in (r.object_key, r.thumb_key)])
        await session.execute(_DELETE_ORPHANS, {"hid": hid, "ids": [r.id for r in rows]})
        return len(rows)

    return sweep


async def sweep_orphan_uploads(ctx: dict[str, Any]) -> dict[str, int]:
    store: ObjectStore = ctx.get("storage") or NoopObjectStore()
    swept = await for_each_household("sweep_orphan_uploads", _sweeper(store))
    log.info("sweep_orphan_uploads_done", swept=swept)
    return {"swept": swept}


# --------------------------------------------------------------------------- #
# purge_deleted_households (hourly, ADR-0017 §4)
# --------------------------------------------------------------------------- #


def _purger(store: ObjectStore) -> HouseholdWork:
    async def purge(session: AsyncSession, hid: uuid.UUID) -> int:
        photos = await household_deletion_service.purge_if_due(session, hid, store)
        if photos is None:
            return 0
        # Ids and counts only: the household's name is gone with it.
        log.info("household_purged", household_id=str(hid), photos=photos)
        return photos

    return purge


async def purge_deleted_households(ctx: dict[str, Any]) -> dict[str, int]:
    store: ObjectStore = ctx.get("storage") or NoopObjectStore()
    photos = await for_each_household("purge_deleted_households", _purger(store))
    log.info("purge_deleted_households_done", photos=photos)
    return {"photos": photos}


# --------------------------------------------------------------------------- #
# remind_disabled_households (daily, ADR-0017 §4)
# --------------------------------------------------------------------------- #


def _reminder(sender: EmailSender) -> HouseholdWork:
    async def remind(session: AsyncSession, hid: uuid.UUID) -> int:
        emails = await household_deletion_service.disabled_reminder(session)
        for message in emails:
            await send_safely(sender, message)
        return 1 if emails else 0

    return remind


async def remind_disabled_households(ctx: dict[str, Any]) -> dict[str, int]:
    """Sends through EMAIL_MODE: the worker needs the email secrets for these to leave."""
    sender: EmailSender = ctx.get("email") or email_sender()
    reminded = await for_each_household("remind_disabled_households", _reminder(sender))
    log.info("remind_disabled_households_done", reminded=reminded)
    return {"reminded": reminded}


# --------------------------------------------------------------------------- #
# Not built yet (06-background-worker.md). Deliberately NOT registered as stubs: a
# registered no-op cron would look healthy on the dashboard while doing nothing.
#   backup_new_photos        - lands with the photo pipeline (needs a real ObjectStore and
#                              the BACKUP_STORAGE_* client, worker only)
#   propagate_photo_deletes  - same
#   refresh_tmdb_cache       - lands with the TMDB integration
#   pg_dump_weekly           - blocked on its own ADR (fnh_app cannot dump FORCE-RLS tables)
# --------------------------------------------------------------------------- #
