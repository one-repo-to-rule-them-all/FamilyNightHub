"""Live updates end to end against real Redis + Postgres (ADR-0004).

Tickets: single-use, expiring, household- and night-bound. The stream: headers, events
after mutations (and only after commit), no ballot data, no subscription left behind
when a phone hangs up. Nothing here sleeps: time moves by monkeypatching the ticket clock,
and the stream's intervals are shrunk only where a test needs a frame to flow.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator

import pytest
from redis.asyncio.client import PubSub
from sqlalchemy import text

from app.api.v1 import stream as stream_api
from app.core.database import after_commit, household_session
from app.core.redis import get_redis
from app.core.security import CSRF_HEADER
from app.realtime import publisher, tickets
from tests.integration.live_stream import LiveStream, subscribers
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import _host, _night, _person, _phone_for, _vote

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"


@pytest.fixture(autouse=True)
def _fast_stream(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Short polls so a hung-up stream notices promptly; no test waits on these."""
    monkeypatch.setattr(stream_api, "POLL_SECONDS", 0.05)
    yield


async def _ticket(p: Phone, sid: str | uuid.UUID) -> str:
    resp = await p.post("/api/v1/sse-tickets", {"session_id": str(sid)})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["expires_in"] == 60
    ticket: str = body["ticket"]
    return ticket


async def _open(sid: str | uuid.UUID, ticket: str, spec: str = "2.3") -> LiveStream:
    return await LiveStream(f"{BASE}/{sid}/stream", f"ticket={ticket}", spec).open()


async def _stream_status(sid: str | uuid.UUID, ticket: str) -> int:
    """Open and immediately drop; returns the status (401s end on their own)."""
    live = await _open(sid, ticket)
    status = live.status
    assert status is not None
    if status == 200:
        await live.hang_up()
    else:
        await live.body()
    return status


# --- Tickets ---------------------------------------------------------------------------


async def test_a_device_and_an_account_can_both_get_a_ticket(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, _ = await _night(host, 2, open_voting=False)
        assert (await kid.join(a.slug, code)).status_code == 200
        for p in (host, kid):
            ticket = await _ticket(p, sid)
            stored = await get_redis().get(tickets.ticket_key(ticket))
            assert json.loads(stored)["session_id"] == sid
            assert json.loads(stored)["household_id"] == str(a.household_id)
            assert 0 < await get_redis().ttl(tickets.ticket_key(ticket)) <= 60


async def test_a_ticket_needs_a_credential_and_the_csrf_header(two_households: Pair) -> None:
    a, _ = two_households
    sid = str(a.ids["session"])
    async with phone() as nobody:
        resp = await nobody.post("/api/v1/sse-tickets", {"session_id": sid})
        assert resp.status_code == 401
    async with phone() as host:
        await _host(host, a)
        await host.csrf()
        resp = await host.client.post("/api/v1/sse-tickets", json={"session_id": sid})
        assert resp.status_code == 403
        assert "CSRF" in resp.json()["error"]["message"]


async def test_another_households_night_gets_no_ticket(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as b_host:
        await _host(b_host, b)
        resp = await b_host.post("/api/v1/sse-tickets", {"session_id": str(a.ids["session"])})
        assert resp.status_code == 404
        resp = await b_host.post("/api/v1/sse-tickets", {"session_id": str(uuid.uuid4())})
        assert resp.status_code == 404


async def test_a_ticket_opens_one_stream_once(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        ticket = await _ticket(host, sid)
    assert await _stream_status(sid, ticket) == 200
    assert await _stream_status(sid, ticket) == 401
    assert await _stream_status(sid, "never-minted") == 401


async def test_an_expired_ticket_is_refused(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        ticket = await _ticket(host, sid)
    minted_at = tickets.now()
    monkeypatch.setattr(tickets, "now", lambda: minted_at + tickets.TICKET_TTL_SECONDS)
    assert await _stream_status(sid, ticket) == 401


async def test_a_ticket_only_opens_the_night_it_was_minted_for(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        other, _, _ = await _night(host, 2, open_voting=False)
        ticket = await _ticket(host, sid)
    assert await _stream_status(other, ticket) == 401
    # Presenting it at the wrong door burned it.
    assert await _stream_status(sid, ticket) == 401


# --- The stream --------------------------------------------------------------------------


async def test_the_stream_is_unbuffered_event_stream(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        live = await _open(sid, await _ticket(host, sid))
    try:
        assert live.status == 200
        assert live.headers["content-type"].startswith("text/event-stream")
        assert live.headers["cache-control"] == "no-cache, no-transform"
        assert live.headers["x-accel-buffering"] == "no"
        assert live.headers["x-request-id"]
        assert await live.frame() == ": connected\n\n"
    finally:
        await live.hang_up()


async def test_mutations_reach_an_open_stream_as_hints(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, options = await _night(host, 3, open_voting=False)
        live = await _open(sid, await _ticket(host, sid))
        try:
            assert await live.frame() == ": connected\n\n"

            resp = await host.client.request(
                "DELETE",
                f"{BASE}/{sid}/options/{options[2]}",
                headers={CSRF_HEADER: await host.csrf()},
            )
            assert resp.status_code == 200
            first = await live.event()
            assert first["type"] == "shortlist_changed"
            assert first["session_id"] == sid

            assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
            second = await live.event()
            assert second["type"] == "status_changed"
            assert second["version"] > first["version"]
        finally:
            await live.hang_up()


async def test_ballots_publish_a_count_hint_with_no_ballot_data(two_households: Pair) -> None:
    a, _ = two_households
    person = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, options = await _night(host, 3)
        await _phone_for(kid, a, code, person)
        live = await _open(sid, await _ticket(kid, sid))
        try:
            assert await live.frame() == ": connected\n\n"
            assert (await _vote(kid, sid, person, options[1], options[0])).status_code == 204
            raw = await live.frame()
            while not raw.startswith("data: "):
                raw = await live.frame()
            event = json.loads(raw.removeprefix("data: "))
            assert set(event) == {"type", "session_id", "version"}
            assert event["type"] == "ballot_count"
            for secret in (*options, str(person), "rank"):
                assert secret not in raw

            close = await host.post(f"{BASE}/{sid}/close-voting")
            assert close.status_code == 200
            revealed = await live.event()
            assert revealed["type"] == "revealed"
            assert set(revealed) == {"type", "session_id", "version"}
        finally:
            await live.hang_up()


async def test_another_nights_events_do_not_cross_streams(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        other, _, _ = await _night(host, 2, open_voting=False)
        live = await _open(sid, await _ticket(host, sid))
        try:
            assert await live.frame() == ": connected\n\n"
            assert (await host.post(f"{BASE}/{other}/open-voting")).status_code == 200
            assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
            event = await live.event()
            assert event["session_id"] == sid
        finally:
            await live.hang_up()


@pytest.mark.parametrize("spec", ["2.3", "2.4"])
async def test_hanging_up_leaves_no_subscription(
    two_households: Pair, spec: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Under 2.4 the app learns of the hang-up on its next send: make that the next poll.
    monkeypatch.setattr(stream_api, "HEARTBEAT_SECONDS", 0.0)
    # Hold every pub/sub the stream opens, so garbage collection can't close a leaked one
    # behind the test's back and make it look cleaned up.
    opened: list[PubSub] = []
    real = get_redis()

    class Spy:
        def pubsub(self) -> PubSub:
            opened.append(real.pubsub())
            return opened[-1]

    monkeypatch.setattr(stream_api, "get_redis", Spy)
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        ticket = await _ticket(host, sid)
    channel = publisher.session_channel(uuid.UUID(sid))
    live = await _open(sid, ticket, spec)
    assert await live.frame() == ": connected\n\n"
    ((_, count),) = await get_redis().pubsub_numsub(channel)
    assert count == 1

    await live.hang_up()
    assert live.task is not None and live.task.done()
    assert await subscribers(channel) == 0
    (pubsub,) = opened
    assert pubsub.connection is None  # closed and returned, not just dropped


async def test_the_stream_closes_itself_after_its_lifetime(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stream_api, "MAX_STREAM_SECONDS", 0.0)
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2, open_voting=False)
        live = await _open(sid, await _ticket(host, sid))
    assert await live.body() == ": connected\n\n"
    assert await subscribers(publisher.session_channel(uuid.UUID(sid))) == 0


# --- Publishing ------------------------------------------------------------------------


async def test_a_redis_outage_never_fails_the_write(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    def down() -> object:
        raise ConnectionError("redis down")

    monkeypatch.setattr(publisher, "get_redis", down)
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _, _ = await _night(host, 2)
        snap = (await host.client.get(f"{BASE}/{sid}")).json()
    assert snap["status"] == "voting"


async def test_hooks_run_only_after_a_commit(two_households: Pair) -> None:
    a, _ = two_households
    ran: list[str] = []

    async def hook() -> None:
        async with household_session(a.household_id) as db:
            title = await db.scalar(
                text("SELECT title FROM sessions WHERE id = :s"), {"s": a.ids["session"]}
            )
        ran.append(title)

    async with household_session(a.household_id) as db:
        await db.execute(
            text("UPDATE sessions SET title = 'Committed' WHERE id = :s"),
            {"s": a.ids["session"]},
        )
        after_commit(db, hook)
        assert ran == []
    assert ran == ["Committed"]  # the hook saw the committed row

    with pytest.raises(RuntimeError):
        async with household_session(a.household_id) as db:
            after_commit(db, hook)
            raise RuntimeError("rolled back")
    assert ran == ["Committed"]
