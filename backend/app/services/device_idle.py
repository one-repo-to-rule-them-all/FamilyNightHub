"""Device idle timeout (ADR-0002 amendment, issue #56).

A phone or TV not used for `DEVICE_IDLE_DAYS` is *expired*: not revoked, but its token stops
working (401 `device_expired`) until it enters a night code again (or a host enrolls it). The
clock is `last_seen_at`, which `device_db` stamps at most once per
DEVICE_TOUCH_INTERVAL_SECONDS, so an active device is never more than that behind.

Reviving an expired device keeps the row (label, history, audit trail) but drops its
`device_people` bindings and its TV flag: whoever holds it now picks their people again with
their PINs, and only a host makes it the TV again.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

# The one definition of "expired"; :cutoff comes from idle_cutoff(). A row never stamped
# falls back to when it was created.
EXPIRED_SQL = "COALESCE(last_seen_at, created_at) < :cutoff"


def idle_cutoff(now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)) - timedelta(days=settings.DEVICE_IDLE_DAYS)


async def is_expired(db: AsyncSession, device_id: uuid.UUID) -> bool:
    expired: bool | None = await db.scalar(
        text(f"SELECT {EXPIRED_SQL} FROM devices WHERE id = :d"),
        {"d": device_id, "cutoff": idle_cutoff()},
    )
    return bool(expired)


async def revive_if_expired(db: AsyncSession, device_id: uuid.UUID) -> bool:
    """Called on a rejoin or host enroll. True if the device was expired and is now live
    again, with no bindings and not the TV; False (and nothing changed) otherwise."""
    revived = await db.execute(
        text(
            f"UPDATE devices SET last_seen_at = now(), is_tv = false "
            f"WHERE id = :d AND {EXPIRED_SQL}"
        ),
        {"d": device_id, "cutoff": idle_cutoff()},
    )
    if not revived.rowcount:  # type: ignore[attr-defined]
        return False
    await db.execute(text("DELETE FROM device_people WHERE device_id = :d"), {"d": device_id})
    return True
