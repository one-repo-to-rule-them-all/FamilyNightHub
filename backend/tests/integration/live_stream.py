"""Drive the SSE route as a raw ASGI client, the way uvicorn does.

httpx's ASGITransport waits for the whole response, which never comes for a stream, and
it cannot disconnect mid-response. This harness calls the app directly, hands the body
frames over as they are sent, and can hang up like a phone going to sleep. Under ASGI
spec 2.3 the hang-up is an `http.disconnect` Starlette listens for; under 2.4 a send
after the hang-up raises OSError, as uvicorn's does.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Any

from starlette.types import Message

from app.core.redis import get_redis
from app.main import app

# Generous bound for a frame that should already be on its way; never a fixed wait.
FRAME_TIMEOUT = 10.0


class LiveStream:
    def __init__(self, path: str, query: str, spec_version: str = "2.3") -> None:
        self.spec_version = spec_version
        self._scope: dict[str, Any] = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": spec_version},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": [(b"host", b"fnh.test")],
            "client": ("127.0.0.1", 50000),
            "server": ("fnh.test", 443),
        }
        self._sent: asyncio.Queue[Message] = asyncio.Queue()
        self._requested = False
        self._gone = asyncio.Event()
        self.task: asyncio.Task[None] | None = None
        self.status: int | None = None
        self.headers: dict[str, str] = {}

    async def _receive(self) -> Message:
        if not self._requested:
            self._requested = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._gone.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message: Message) -> None:
        if self._gone.is_set() and self.spec_version >= "2.4":
            raise OSError("client disconnected")
        await self._sent.put(message)

    async def open(self) -> LiveStream:
        self.task = asyncio.create_task(app(self._scope, self._receive, self._send))
        start = await asyncio.wait_for(self._sent.get(), FRAME_TIMEOUT)
        assert start["type"] == "http.response.start"
        self.status = start["status"]
        self.headers = {k.decode(): v.decode() for k, v in start["headers"]}
        return self

    async def body(self) -> str:
        """Everything the app sends until it finishes (non-streaming error responses)."""
        chunks = []
        while True:
            msg = await asyncio.wait_for(self._sent.get(), FRAME_TIMEOUT)
            chunks.append(msg.get("body", b"").decode())
            if not msg.get("more_body"):
                return "".join(chunks)

    async def frame(self) -> str:
        """The next non-empty body chunk; one SSE frame or comment."""
        while True:
            msg = await asyncio.wait_for(self._sent.get(), FRAME_TIMEOUT)
            assert msg["type"] == "http.response.body"
            if msg.get("body"):
                return str(msg["body"].decode())
            assert msg.get("more_body"), "stream ended"

    async def event(self) -> dict[str, Any]:
        """The next data frame, skipping heartbeat comments."""
        while True:
            frame = await self.frame()
            if frame.startswith("data: "):
                data: dict[str, Any] = json.loads(frame.removeprefix("data: "))
                return data

    async def hang_up(self) -> None:
        self._gone.set()
        assert self.task is not None
        with suppress(Exception):
            await asyncio.wait_for(self.task, FRAME_TIMEOUT)


async def subscribers(channel: str) -> int:
    """Subscribers on a channel, polled a bounded number of round trips: the stream's
    UNSUBSCRIBE travels on its own connection, so it may land just after we ask."""
    redis = get_redis()
    count = 0
    for _ in range(200):
        ((_, count),) = await redis.pubsub_numsub(channel)
        if count == 0:
            return 0
        await redis.ping()
    return int(count)
