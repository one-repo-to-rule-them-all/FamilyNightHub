"""Live updates over SSE (ADR-0004): mint a ticket, then stream one night's hints.

Adapted from OrderUp backend/app/api/v1/portal/sse.py @ 2f86cd8. Two routes, two auth
mechanisms by design:

- `POST /sse-tickets` is a normal cookie route (any device or account of the household,
  CSRF-protected). It mints a 60s single-use ticket bound to the household *and* the night.
- `GET /sessions/{id}/stream?ticket=` carries no cookie check: `EventSource` can't send a
  CSRF header, and the ticket is the credential. It is consumed (single-use) before any
  response starts, so a bad, used, expired or wrong-night ticket gets a clean 401. The
  channel name comes from the ticket's night, never from anything else the client sent.

The stream forwards `{type, session_id, version}` as unnamed `data:` frames (the browser's
`onmessage` sees them all), rebuilt from those three fields only, so nothing else a
publisher put on the channel could reach a phone. It sends a comment right after
subscribing (so `onopen` fires and proxies flush), a heartbeat comment every 15s, and
ends after 30 minutes so the client re-tickets. If Redis fails it sends a `degraded`
frame and ends; clients poll the snapshot until they reconnect.

Disconnects must not leak the Redis subscription (phones drop streams constantly).
Starlette either cancels the generator mid-await (ASGI < 2.4) or abandons it after a
failed send (ASGI 2.4). `LiveStreamResponse` closes the generator in both cases, and the
generator's cleanup runs shielded from cancellation, so unsubscribe always happens. The
app's request-ID middleware is pure ASGI for the same reason (main.py).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Callable
from typing import Annotated, Any

import anyio
import structlog
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from starlette.types import Receive, Scope, Send

from app.api.v1.sessions import NOT_FOUND, raise_http
from app.core.dependencies import CsrfProtected, CurrentViewer, ViewerDb
from app.core.redis import get_redis
from app.realtime.events import DEGRADED
from app.realtime.publisher import session_channel
from app.realtime.tickets import TICKET_TTL_SECONDS, consume_ticket
from app.schemas.live import SseTicketIn, SseTicketOut
from app.services import live_service
from app.services.errors import NotFound

router = APIRouter(tags=["live"])
log = structlog.get_logger()

# Module-level so tests can shrink them; no test waits on wall-clock time.
HEARTBEAT_SECONDS = 15.0
MAX_STREAM_SECONDS = 30 * 60.0
# How long one pub/sub poll blocks before re-checking the deadline and heartbeat.
POLL_SECONDS = 1.0

SSE_HEADERS = {
    # no-transform stops the Next proxy in fnh-web gzip-buffering the stream (02-environments).
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
}


def _frame(event_type: str, session_id: str, version: int | None) -> str:
    data = json.dumps({"type": event_type, "session_id": session_id, "version": version})
    return f"data: {data}\n\n"


def _forward(raw: Any, session_id: str) -> str | None:
    """Re-serialize a published hint from its three allowed fields; drop anything else."""
    try:
        decoded = json.loads(raw)
        event_type = decoded["type"]
        version = decoded["version"]
    except (TypeError, ValueError, KeyError):
        return None
    if not isinstance(event_type, str) or not isinstance(version, int):
        return None
    return _frame(event_type, session_id, version)


async def event_stream(
    session_id: uuid.UUID,
    *,
    redis: Redis | None = None,
    heartbeat: float | None = None,
    max_seconds: float | None = None,
    poll: float | None = None,
    clock: Callable[[], float] | None = None,
) -> AsyncGenerator[str, None]:
    heartbeat = HEARTBEAT_SECONDS if heartbeat is None else heartbeat
    max_seconds = MAX_STREAM_SECONDS if max_seconds is None else max_seconds
    poll = POLL_SECONDS if poll is None else poll
    clock = clock or anyio.current_time
    sid = str(session_id)
    channel = session_channel(session_id)
    pubsub = (redis or get_redis()).pubsub()
    deadline = clock() + max_seconds
    try:
        try:
            await pubsub.subscribe(channel)
            yield ": connected\n\n"
            last_sent = clock()
            while (now := clock()) < deadline:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=min(poll, deadline - now)
                )
                if message is None:
                    if clock() - last_sent >= heartbeat:
                        yield ": heartbeat\n\n"
                        last_sent = clock()
                    continue
                frame = _forward(message["data"], sid)
                if frame is not None:
                    yield frame
                    last_sent = clock()
        except (ConnectionError, OSError) as exc:  # redis-py's ConnectionError subclasses both
            log.warning("live_stream_redis_error", session_id=sid, error=str(exc))
            yield _frame(DEGRADED, sid, None)
    finally:
        # Shielded: on a client disconnect this runs inside a cancelled scope, where an
        # unshielded await would be cancelled too and leave the subscription open.
        with anyio.CancelScope(shield=True):
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.aclose()  # type: ignore[no-untyped-call]
            except Exception:  # noqa: BLE001 - best-effort cleanup on a dying connection
                log.warning("live_stream_cleanup_failed", session_id=sid, exc_info=True)


class LiveStreamResponse(StreamingResponse):
    """StreamingResponse that always closes its generator, however the client left.

    Under ASGI spec 2.4 Starlette stops iterating after a failed send and never closes the
    generator; it would sit subscribed until garbage collection.
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            aclose = getattr(self.body_iterator, "aclose", None)
            if aclose is not None:
                with anyio.CancelScope(shield=True):
                    await aclose()


@router.post(
    "/sse-tickets",
    response_model=SseTicketOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def create_sse_ticket(body: SseTicketIn, viewer: CurrentViewer, db: ViewerDb) -> SseTicketOut:
    """A 60s single-use ticket for this night's live stream. Another household's night
    (or an unknown one) is 404."""
    try:
        ticket = await live_service.issue_ticket(db, viewer.household_id, body.session_id)
    except NotFound as err:
        raise_http(err)
    return SseTicketOut(ticket=ticket, expires_in=TICKET_TTL_SECONDS)


@router.get(
    "/sessions/{session_id}/stream",
    response_class=LiveStreamResponse,
    responses={
        200: {"content": {"text/event-stream": {}}, "description": "Live hints for the night"},
        401: {"description": "Ticket invalid, expired, already used or for another night"},
    },
)
async def stream_session(
    session_id: uuid.UUID, ticket: Annotated[str, Query(max_length=128)]
) -> LiveStreamResponse:
    claims = await consume_ticket(ticket)
    if claims is None or claims.session_id != session_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid, expired or used ticket")
    return LiveStreamResponse(
        event_stream(claims.session_id), media_type="text/event-stream", headers=SSE_HEADERS
    )
