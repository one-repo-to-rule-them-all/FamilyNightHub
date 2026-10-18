"""The request transaction must COMMIT before the response starts (core/dependencies.py).

Deterministic, no timing: the app is wrapped so that, at the instant it emits
`http.response.start`, we look for the write from a *separate* connection. Under
FastAPI's default dependency scope the commit would still be pending at that point, and
a phone refetching straight after a 200 could read stale state (seen as flaky e2e on
/who and /s).
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from starlette.types import Message, Receive, Scope, Send

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.main import app
from tests.integration.phones import open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "CMT234"


class SeenAtResponseStart:
    """ASGI wrapper: runs `probe()` the moment the wrapped app starts its response."""

    def __init__(self, probe: Any) -> None:
        self.probe = probe
        self.results: list[bool] = []

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start" and scope.get("method") == "PUT":
                self.results.append(await self.probe())
            await send(message)

        await app(scope, receive, send_wrapper)


async def test_binding_is_committed_before_the_response_starts(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with household_session(a.household_id) as db:
        person: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, 'Probe', 'x', '#000000') RETURNING id"
                ),
                {"h": a.household_id},
            )
        ).scalar_one()

    async def committed() -> bool:
        async with household_session(a.household_id) as db:
            found = await db.scalar(
                text("SELECT 1 FROM device_people WHERE person_id = :p"), {"p": person}
            )
        return found is not None

    # Join with the normal client, then reuse its cookies on the probing transport.
    async with phone() as p:
        assert (await p.join(a.slug, CODE)).status_code == 200
        csrf = await p.csrf()
        cookies = p.client.cookies

    wrapper = SeenAtResponseStart(committed)
    async with AsyncClient(
        transport=ASGITransport(app=wrapper), base_url="https://fnh.test", cookies=cookies
    ) as client:
        # ADR-0014: a first claim sets the person's PIN in the same request.
        resp = await client.put(
            f"/api/v1/devices/me/people/{person}",
            headers={CSRF_HEADER: csrf},
            json={"pin": "246810"},
        )
    assert resp.status_code == 200, resp.text
    assert wrapper.results == [True], "write was not committed when the response started"
