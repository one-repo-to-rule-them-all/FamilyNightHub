"""Deleting a whole household (ADR-0017 §4).

An admin asks with their password and the household's name typed out. Nothing is removed
then: `delete_after` is set HOUSEHOLD_DELETE_GRACE_DAYS ahead, every admin is emailed, and
any admin can cancel until it passes. The worker's `purge_deleted_households` then deletes
every photo object from the bucket (storage first, so an outage leaves everything for the
next tick) and the household row, which cascades to every household table.

Nights keep running during the wait: the point of the wait is a mistaken or hostile request,
not a shutdown.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import hashing
from app.core.config import settings
from app.integrations.email import Email
from app.integrations.storage import ObjectStore
from app.services.errors import Conflict, Forbidden, Invalid

WRONG_NAME = "That isn't the household's name. Type it exactly as shown."
ALREADY = "This household is already scheduled for deletion."
NOT_SCHEDULED = "This household isn't scheduled for deletion."


class WrongPassword(Forbidden):
    """The requesting admin's password didn't match. The router spends their login budget."""


@dataclass(frozen=True)
class DeletionStatus:
    household_name: str
    requested_at: datetime | None
    requested_by: str | None
    delete_after: datetime | None


@dataclass(frozen=True)
class Scheduled:
    status: DeletionStatus
    emails: list[Email]


async def status(db: AsyncSession) -> DeletionStatus:
    row = (
        await db.execute(
            text(
                "SELECT h.name, h.deletion_requested_at, h.delete_after, a.display_name "
                "FROM households h LEFT JOIN accounts a ON a.id = h.deletion_requested_by"
            )
        )
    ).one()
    return DeletionStatus(row.name, row.deletion_requested_at, row.display_name, row.delete_after)


async def _admin_emails(db: AsyncSession) -> list[str]:
    rows = await db.execute(
        text("SELECT email FROM accounts WHERE role = 'admin' AND disabled_at IS NULL")
    )
    return [r.email for r in rows]


async def _audit(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, action: str, data: str
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, :action, 'household', :h, CAST(:d AS jsonb))"
        ),
        {"h": household_id, "a": account_id, "action": action, "d": data},
    )


async def request(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    password: str,
    household_name: str,
) -> Scheduled:
    """Schedule the delete. The password is checked first (one argon2 run whatever the name),
    then the typed name, then that nothing is already scheduled."""
    stored: str | None = await db.scalar(
        text("SELECT password_hash FROM accounts WHERE id = :a"), {"a": account_id}
    )
    if not await hashing.verify_password(stored, password):
        raise WrongPassword("Your password is wrong")
    current = (
        await db.execute(
            text("SELECT name, delete_after FROM households WHERE id = :h FOR UPDATE"),
            {"h": household_id},
        )
    ).one()
    if household_name.strip().casefold() != current.name.strip().casefold():
        raise Invalid(WRONG_NAME)
    if current.delete_after is not None:
        raise Conflict(ALREADY)
    delete_after = datetime.now(UTC) + timedelta(days=settings.HOUSEHOLD_DELETE_GRACE_DAYS)
    await db.execute(
        text(
            "UPDATE households SET deletion_requested_at = now(), deletion_requested_by = :a, "
            "delete_after = :d WHERE id = :h"
        ),
        {"a": account_id, "d": delete_after, "h": household_id},
    )
    await _audit(
        db,
        household_id,
        account_id,
        "household.deletion_requested",
        json.dumps({"delete_after": delete_after.isoformat()}),
    )
    result = await status(db)
    when = f"{delete_after:%A %B} {delete_after.day}"
    link = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/admin/settings#data"
    emails = [
        Email(
            to=address,
            subject=f"{result.household_name} will be deleted on {when}",
            text=(
                f"{result.requested_by} asked to delete {result.household_name} from Family "
                f"Night. On {when} (UTC) its people, nights, votes and photos will be erased "
                "for good.\n\n"
                f"Any admin can cancel before then in Settings:\n\n{link}\n\n"
                "If you didn't expect this, cancel it and talk to your family."
            ),
        )
        for address in await _admin_emails(db)
    ]
    return Scheduled(result, emails)


async def cancel(db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID) -> Scheduled:
    scheduled = (
        await db.execute(
            text("SELECT delete_after FROM households WHERE id = :h FOR UPDATE"),
            {"h": household_id},
        )
    ).scalar_one()
    if scheduled is None:
        raise Conflict(NOT_SCHEDULED)
    await db.execute(
        text(
            "UPDATE households SET deletion_requested_at = NULL, deletion_requested_by = NULL, "
            "delete_after = NULL WHERE id = :h"
        ),
        {"h": household_id},
    )
    await _audit(db, household_id, account_id, "household.deletion_cancelled", "{}")
    result = await status(db)
    by: str = await db.scalar(
        text("SELECT display_name FROM accounts WHERE id = :a"), {"a": account_id}
    )
    emails = [
        Email(
            to=address,
            subject=f"{result.household_name} will not be deleted",
            text=f"{by} cancelled the deletion of {result.household_name}. Nothing was removed.",
        )
        for address in await _admin_emails(db)
    ]
    return Scheduled(result, emails)


# --- Worker --------------------------------------------------------------------------


async def purge_if_due(db: AsyncSession, household_id: uuid.UUID, store: ObjectStore) -> int | None:
    """Erase the household if its delete is due; returns the photos removed, None if not due.
    Runs in the worker's household transaction: storage first, then the row (cascading to
    every household table), so a storage failure keeps everything for the next tick."""
    due = (
        await db.execute(
            text("SELECT id FROM households WHERE id = :h AND delete_after <= now() FOR UPDATE"),
            {"h": household_id},
        )
    ).first()
    if due is None:
        return None
    rows: list[Any] = list(await db.execute(text("SELECT object_key, thumb_key FROM photos")))
    keys = [key for r in rows for key in (r.object_key, r.thumb_key)]
    if keys:
        await store.delete_objects(keys)
    await db.execute(text("DELETE FROM households WHERE id = :h"), {"h": household_id})
    return len(rows)


REMIND_AFTER = timedelta(days=365)


async def disabled_reminder(db: AsyncSession) -> list[Email]:
    """ADR-0017 §4: a household switched off for a year (and not reminded in the last year)
    reminds its admins that its data is still kept, and how to get it deleted."""
    row = (
        await db.execute(
            text(
                "SELECT name FROM households WHERE disabled_at <= :cutoff "
                "AND (disable_reminded_at IS NULL OR disable_reminded_at <= :cutoff) FOR UPDATE"
            ),
            {"cutoff": datetime.now(UTC) - REMIND_AFTER},
        )
    ).first()
    if row is None:
        return []
    await db.execute(text("UPDATE households SET disable_reminded_at = now()"))
    return [
        Email(
            to=address,
            subject=f"{row.name} is still kept on Family Night",
            text=(
                f"{row.name} has been switched off for over a year. Its people, nights and "
                "photos are still kept. To have them deleted, or to get a copy first, reply to "
                "this email."
            ),
        )
        for address in await _admin_emails(db)
    ]
