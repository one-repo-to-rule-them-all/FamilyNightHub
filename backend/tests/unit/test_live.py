"""Live updates without a data plane: tickets on a fake clock, the stream generator on a
fake pub/sub, the publisher's failure path and the after-commit runner (ADR-0004)."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any, cast

import pytest
from redis.asyncio import Redis

from app.api.v1 import stream
from app.core import database
from app.realtime import events, publisher, tickets


class FakeClock:
    def __init__(self, start: float = 1_000.0, step: float = 0.0) -> None:
        self.now = start
        self.step = step

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        return value


class FakeRedis:
    """SET ex= / GETDEL with expiry on the injected clock, like Redis's own TTL."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.data: dict[str, tuple[str, float]] = {}

    async def set(self, key: str, value: str, ex: int) -> None:
        self.data[key] = (value, self.clock.now + ex)

    async def getdel(self, key: str) -> str | None:
        item = self.data.pop(key, None)
        if item is None or self.clock.now >= item[1]:
            return None
        return item[0]


def _redis(fake: object) -> Redis:
    return cast(Redis, fake)


# --- Tickets ---------------------------------------------------------------------------


async def test_a_ticket_is_bound_to_its_household_and_night_and_works_once() -> None:
    clock = FakeClock()
    redis = FakeRedis(clock)
    hid, sid = uuid.uuid4(), uuid.uuid4()
    ticket = await tickets.mint_ticket(hid, sid, redis=_redis(redis), clock=clock)

    assert len(ticket) >= 43  # 256 bits, url-safe
    (key,) = redis.data
    assert key == tickets.ticket_key(ticket)
    assert redis.data[key][1] == clock.now + tickets.TICKET_TTL_SECONDS

    claims = await tickets.consume_ticket(ticket, redis=_redis(redis), clock=clock)
    assert claims == tickets.TicketClaims(hid, sid)
    assert await tickets.consume_ticket(ticket, redis=_redis(redis), clock=clock) is None


async def test_tickets_are_unique() -> None:
    redis = FakeRedis(FakeClock())
    hid, sid = uuid.uuid4(), uuid.uuid4()
    minted = {await tickets.mint_ticket(hid, sid, redis=_redis(redis)) for _ in range(20)}
    assert len(minted) == 20


@pytest.mark.parametrize(("age", "valid"), [(0, True), (59.9, True), (60, False), (3600, False)])
async def test_a_ticket_expires_after_60_seconds(age: float, valid: bool) -> None:
    clock = FakeClock()
    redis = FakeRedis(clock)
    ticket = await tickets.mint_ticket(uuid.uuid4(), uuid.uuid4(), redis=_redis(redis), clock=clock)
    clock.now += age
    claims = await tickets.consume_ticket(ticket, redis=_redis(redis), clock=clock)
    assert (claims is not None) is valid


async def test_the_stamped_expiry_holds_even_if_redis_kept_the_key() -> None:
    """Belt and braces: a store that ignored the TTL still can't revive an old ticket."""
    mint_clock, late = FakeClock(), FakeClock(start=1_000.0 + tickets.TICKET_TTL_SECONDS)
    redis = FakeRedis(mint_clock)
    ticket = await tickets.mint_ticket(
        uuid.uuid4(), uuid.uuid4(), redis=_redis(redis), clock=mint_clock
    )
    assert await tickets.consume_ticket(ticket, redis=_redis(redis), clock=late) is None


@pytest.mark.parametrize(
    "stored",
    ["not json", "[]", json.dumps({"household_id": "x", "session_id": "y", "exp": 9e9}), "{}"],
)
async def test_a_garbled_ticket_is_refused(stored: str) -> None:
    clock = FakeClock()
    redis = FakeRedis(clock)
    redis.data[tickets.ticket_key("t")] = (stored, clock.now + 60)
    assert await tickets.consume_ticket("t", redis=_redis(redis), clock=clock) is None


def test_the_default_clock_is_wall_time() -> None:
    assert tickets.now() > 1_700_000_000


# --- Registry and publisher ---------------------------------------------------------------


def test_only_registered_events_publish() -> None:
    for name in events.PUBLISHED_EVENTS:
        events.assert_registered(name)
    with pytest.raises(events.UnknownLiveEventError):
        events.assert_registered("ballots_tallied")
    with pytest.raises(events.UnknownLiveEventError):
        events.assert_registered(events.DEGRADED)  # synthesized by the stream only


async def test_an_unknown_type_raises_even_on_the_best_effort_path() -> None:
    with pytest.raises(events.UnknownLiveEventError):
        await publisher.publish_session_event(uuid.uuid4(), "typo", redis=_redis(object()))

    class Session:
        info: dict[str, Any] = {}

    with pytest.raises(events.UnknownLiveEventError):
        publisher.publish_after_commit(cast(Any, Session()), uuid.uuid4(), "typo")


async def test_a_redis_failure_is_logged_not_raised() -> None:
    class Broken:
        def pipeline(self, **_: Any) -> Any:
            raise ConnectionError("redis down")

    await publisher.publish_session_event(
        uuid.uuid4(), events.STATUS_CHANGED, redis=_redis(Broken())
    )


def test_the_payload_has_exactly_three_fields() -> None:
    sid = uuid.uuid4()
    payload = json.loads(publisher.event_payload(events.BALLOT_COUNT, sid, 7))
    assert payload == {"type": "ballot_count", "session_id": str(sid), "version": 7}
    assert publisher.session_channel(sid) == f"session:{sid}"


# --- After-commit hooks -------------------------------------------------------------------


async def test_after_commit_hooks_run_in_order_and_a_failing_one_does_not_stop_the_rest() -> None:
    class Session:
        def __init__(self) -> None:
            self.info: dict[str, Any] = {}

    session = cast(Any, Session())
    ran: list[str] = []

    async def first() -> None:
        ran.append("first")

    async def broken() -> None:
        raise RuntimeError("boom")

    async def last() -> None:
        ran.append("last")

    for hook in (first, broken, last):
        database.after_commit(session, hook)
    await database._run_after_commit(session)
    assert ran == ["first", "last"]
    await database._run_after_commit(session)  # hooks run once
    assert ran == ["first", "last"]


# --- The stream generator -------------------------------------------------------------------


class FakePubSub:
    def __init__(self, messages: list[Any]) -> None:
        self.messages = messages
        self.subscribed: list[str] = []
        self.closed = False

    async def subscribe(self, channel: str) -> None:
        self.subscribed.append(channel)

    async def unsubscribe(self, channel: str) -> None:
        self.subscribed.remove(channel)

    async def aclose(self) -> None:
        self.closed = True

    async def get_message(self, *, ignore_subscribe_messages: bool, timeout: float) -> Any:  # noqa: ASYNC109 - mirrors redis-py
        assert ignore_subscribe_messages
        assert timeout >= 0
        if not self.messages:
            return None
        item = self.messages.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


class FakePubSubRedis:
    def __init__(self, pubsub: FakePubSub) -> None:
        self._pubsub = pubsub

    def pubsub(self) -> FakePubSub:
        return self._pubsub


async def _drain(gen: AsyncGenerator[str, None]) -> list[str]:
    return [frame async for frame in gen]


def _gen(
    pubsub: FakePubSub, sid: uuid.UUID, clock: FakeClock, **kw: float
) -> AsyncGenerator[str, None]:
    return stream.event_stream(
        sid, redis=_redis(FakePubSubRedis(pubsub)), clock=clock, poll=0.0, **kw
    )


def _published(sid: uuid.UUID, event_type: str, version: int, **extra: Any) -> dict[str, Any]:
    body = {"type": event_type, "session_id": str(sid), "version": version, **extra}
    return {"type": "message", "data": json.dumps(body)}


async def test_the_stream_forwards_only_the_three_fields_and_ends_at_the_deadline() -> None:
    sid = uuid.uuid4()
    leaky = _published(sid, "ballot_count", 3, ranks=[1, 2], tally={"a": 9})
    pubsub = FakePubSub([leaky, {"type": "message", "data": "garbage"}, None])
    # Each clock read moves 1s; the stream may live 10s, heartbeats only after 100s.
    frames = await _drain(_gen(pubsub, sid, FakeClock(step=1.0), heartbeat=100.0, max_seconds=10.0))

    assert frames[0] == ": connected\n\n"
    data = [json.loads(f.removeprefix("data: ")) for f in frames if f.startswith("data: ")]
    assert data == [{"type": "ballot_count", "session_id": str(sid), "version": 3}]
    assert "ranks" not in "".join(frames)
    assert pubsub.subscribed == []  # unsubscribed
    assert pubsub.closed


async def test_the_stream_heartbeats_when_quiet() -> None:
    pubsub = FakePubSub([])
    frames = await _drain(
        _gen(pubsub, uuid.uuid4(), FakeClock(step=1.0), heartbeat=2.0, max_seconds=12.0)
    )
    assert frames.count(": heartbeat\n\n") >= 2
    assert all(f.startswith(":") for f in frames)


@pytest.mark.parametrize("payload", [{"type": 1, "version": 2}, {"type": "x", "version": "2"}])
async def test_malformed_hints_are_dropped(payload: dict[str, Any]) -> None:
    pubsub = FakePubSub([{"type": "message", "data": json.dumps(payload)}])
    frames = await _drain(
        _gen(pubsub, uuid.uuid4(), FakeClock(step=1.0), heartbeat=100.0, max_seconds=5.0)
    )
    assert frames == [": connected\n\n"]


async def test_a_redis_failure_degrades_the_stream_and_cleans_up() -> None:
    sid = uuid.uuid4()
    pubsub = FakePubSub([ConnectionError("gone")])
    frames = await _drain(_gen(pubsub, sid, FakeClock(step=1.0), max_seconds=60.0))
    assert frames[-1] == (
        f'data: {{"type": "degraded", "session_id": "{sid}", "version": null}}\n\n'
    )
    assert pubsub.closed


async def test_cleanup_failures_are_swallowed() -> None:
    class Sticky(FakePubSub):
        async def unsubscribe(self, channel: str) -> None:
            raise ConnectionError("already gone")

    frames = await _drain(
        _gen(Sticky([]), uuid.uuid4(), FakeClock(step=1.0), heartbeat=100.0, max_seconds=3.0)
    )
    assert frames == [": connected\n\n"]


async def test_closing_the_generator_early_unsubscribes() -> None:
    pubsub = FakePubSub([])
    gen = _gen(pubsub, uuid.uuid4(), FakeClock(step=0.0), heartbeat=100.0, max_seconds=60.0)
    assert await anext(gen) == ": connected\n\n"
    await gen.aclose()
    assert pubsub.subscribed == []
    assert pubsub.closed
