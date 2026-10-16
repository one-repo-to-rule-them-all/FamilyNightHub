"""Publish live hints to `session:{id}` (ADR-0004), after the transaction commits.

Adapted from OrderUp backend/app/realtime/publisher.py @ 2f86cd8 (`publish_session_event`
and the best-effort `publish_guest_session_event`). Differences: one channel per night,
a fixed three-field payload, and a per-night `version`.

Services call `publish_after_commit(db, session_id, type)`; the event goes out only once
`household_session` has committed (`app/core/database.after_commit`), so a client that
refetches on the hint reads the new state, and a rolled-back write publishes nothing.
Publishing is best-effort: a Redis failure is logged and never fails the request, since
clients poll while the stream is down. An unregistered type still raises.

Payload contract: `{type, session_id, version}` and nothing more. `version` increments per
night (Redis INCR), so a client can ignore duplicates and notice gaps; it is a hint, not
a snapshot version. Never add ballots, ranks, tallies or names here.
"""

from __future__ import annotations

import json
import uuid

import structlog
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import after_commit
from app.core.redis import get_redis
from app.realtime.events import SESSION, assert_registered

log = structlog.get_logger()

# A night lasts an evening; the counter outlives it comfortably and then goes away.
VERSION_TTL_SECONDS = 2 * 24 * 3600


def session_channel(session_id: uuid.UUID) -> str:
    return f"{SESSION}:{session_id}"


def _version_key(session_id: uuid.UUID) -> str:
    # Not under `session:*`: that prefix is the pub/sub channel namespace (06-background-worker).
    return f"live_version:{session_id}"


def event_payload(event_type: str, session_id: uuid.UUID, version: int) -> str:
    return json.dumps({"type": event_type, "session_id": str(session_id), "version": version})


async def publish_session_event(
    session_id: uuid.UUID, event_type: str, *, redis: Redis | None = None
) -> None:
    """PUBLISH one hint now. Call only after the change is committed (or use
    `publish_after_commit`). Never raises on Redis errors."""
    assert_registered(event_type)
    try:
        client = redis or get_redis()
        async with client.pipeline(transaction=True) as pipe:
            pipe.incr(_version_key(session_id))
            pipe.expire(_version_key(session_id), VERSION_TTL_SECONDS)
            version, _ = await pipe.execute()
        await client.publish(
            session_channel(session_id), event_payload(event_type, session_id, int(version))
        )
    except Exception as exc:  # noqa: BLE001 - a lost hint must never fail a committed write
        # Not `event=`: structlog reserves it (OrderUp note).
        log.warning(
            "live_event_publish_failed",
            session_id=str(session_id),
            event_type=event_type,
            error=str(exc),
        )


def publish_after_commit(db: AsyncSession, session_id: uuid.UUID, event_type: str) -> None:
    """Queue a hint to go out once `db`'s transaction commits (nothing on rollback)."""
    assert_registered(event_type)

    async def publish() -> None:
        await publish_session_event(session_id, event_type)

    after_commit(db, publish)
