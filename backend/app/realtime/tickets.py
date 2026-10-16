"""SSE tickets: mint and consume (ADR-0004).

Copied from OrderUp backend/app/realtime/tickets.py @ 2f86cd8, then bound to one night:
the stored value is the household *and* the session the ticket was minted for, and the
stream refuses a ticket presented for any other night.

A ticket is a capability, not an identity: an opaque 256-bit token, single-use, 60s.
`EventSource` cannot send custom headers, and the stream URL is a query string that may
land in proxy logs, so it carries this short-lived ticket rather than a cookie-equivalent.
Single-use is atomic (GETDEL). Expiry is enforced twice: by the Redis TTL, and by the
`exp` stamped in the value against an injectable clock, which is what lets tests move
time without sleeping.
"""

from __future__ import annotations

import json
import secrets
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from redis.asyncio import Redis

from app.core.redis import get_redis

TICKET_TTL_SECONDS = 60
_PREFIX = "sse_ticket:"

Clock = Callable[[], float]


def now() -> float:
    """Wall clock; tests pass `clock=` or monkeypatch this to move time without sleeping."""
    return time.time()


@dataclass(frozen=True)
class TicketClaims:
    household_id: uuid.UUID
    session_id: uuid.UUID


def ticket_key(ticket: str) -> str:
    return f"{_PREFIX}{ticket}"


async def mint_ticket(
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    redis: Redis | None = None,
    clock: Clock | None = None,
) -> str:
    """Store a fresh single-use ticket for one night of one household and return it."""
    ticket = secrets.token_urlsafe(32)
    value = json.dumps(
        {
            "household_id": str(household_id),
            "session_id": str(session_id),
            "exp": (clock or now)() + TICKET_TTL_SECONDS,
        }
    )
    await (redis or get_redis()).set(ticket_key(ticket), value, ex=TICKET_TTL_SECONDS)
    return ticket


async def consume_ticket(
    ticket: str, *, redis: Redis | None = None, clock: Clock | None = None
) -> TicketClaims | None:
    """Atomically get-and-delete. The claims if the ticket existed, was unused and is
    unexpired; else None. A second call with the same ticket is always None, including a
    concurrent one (GETDEL is atomic)."""
    raw = await (redis or get_redis()).getdel(ticket_key(ticket))
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        claims = TicketClaims(uuid.UUID(data["household_id"]), uuid.UUID(data["session_id"]))
        expires_at = float(data["exp"])
    except (TypeError, ValueError, KeyError):
        return None
    if (clock or now)() >= expires_at:
        return None
    return claims
