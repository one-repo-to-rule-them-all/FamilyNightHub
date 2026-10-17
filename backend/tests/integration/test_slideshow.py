"""The host's Start/Stop for the TV slideshow (issue #41, 03-backend.md "Nights").

Host-only (`sessions:run`), CSRF-protected, another household's night is a 404, every change
writes an audit row, and the `status_changed` hint goes out only after the row is committed.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.realtime import events, publisher
from tests.integration.phones import Phone, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_photos import _host

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"
CODE = "SHW234"


def _url(h: SeededHousehold) -> str:
    return f"{BASE}/{h.ids['session']}/slideshow"


async def _put(p: Phone, url: str, playing: bool, *, csrf: bool = True) -> Any:
    headers = {CSRF_HEADER: await p.csrf()} if csrf else {}
    return await p.client.put(url, json={"playing": playing}, headers=headers)


async def _row(h: SeededHousehold) -> Any:
    async with household_session(h.household_id) as db:
        return (
            await db.execute(
                text(
                    "SELECT status, slideshow_started_at, slideshow_stopped_at FROM sessions "
                    "WHERE id = :s"
                ),
                {"s": h.ids["session"]},
            )
        ).one()


async def _actions(h: SeededHousehold) -> list[tuple[str, dict[str, Any]]]:
    async with household_session(h.household_id) as db:
        rows = await db.execute(
            text(
                "SELECT action, data FROM audit_events WHERE target_id = :s "
                "AND action LIKE 'session.slideshow%' ORDER BY created_at"
            ),
            {"s": h.ids["session"]},
        )
        return [(r.action, r.data) for r in rows]


async def test_start_and_stop_drive_the_snapshot(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, "tonight")
    sent: list[tuple[str, Any]] = []
    real = publisher.publish_session_event

    async def record(session_id: uuid.UUID, event_type: str, **kw: Any) -> None:
        # Runs after commit: a fresh transaction already sees the new state.
        sent.append((event_type, (await _row(a)).slideshow_started_at))
        await real(session_id, event_type, **kw)

    monkeypatch.setattr(publisher, "publish_session_event", record)

    async with phone() as host:
        await _host(host, a)
        before = (await host.client.get(f"{BASE}/{a.ids['session']}")).json()
        assert before["slideshow"] == "auto" and before["slideshow_started_at"] is None

        resp = await _put(host, _url(a), True)
        assert resp.status_code == 200, resp.text
        started = resp.json()
        assert started["slideshow"] == "playing" and started["slideshow_started_at"] is not None
        assert sent == [(events.STATUS_CHANGED, (await _row(a)).slideshow_started_at)]
        assert sent[0][1] is not None  # the hook saw the committed row, not the old NULL

        # A second Start restarts: a new timestamp, a new hint.
        again = (await _put(host, _url(a), True)).json()
        assert again["slideshow_started_at"] > started["slideshow_started_at"]
        assert len(sent) == 2

        stopped = (await _put(host, _url(a), False)).json()
        assert stopped["slideshow"] == "stopped" and stopped["slideshow_started_at"] is None
        assert len(sent) == 3 and sent[2] == (events.STATUS_CHANGED, None)

        # Stop is idempotent: nothing written, audited or published.
        assert (await _put(host, _url(a), False)).json()["slideshow"] == "stopped"
        assert len(sent) == 3

    row = await _row(a)
    assert row.slideshow_started_at is None and row.slideshow_stopped_at is not None
    assert [act for act, _ in await _actions(a)] == [
        "session.slideshow_started",
        "session.slideshow_started",
        "session.slideshow_stopped",
    ]
    assert all(data == {"status": "tonight"} for _, data in await _actions(a))


async def test_a_closed_night_can_still_run_the_slideshow(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, "closed")
    async with phone() as host:
        await _host(host, a)
        resp = await _put(host, _url(a), True)
    assert resp.status_code == 200, resp.text
    assert resp.json()["slideshow"] == "playing"


async def test_a_settled_reveal_counts_as_tonight_and_is_persisted(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, "revealed")
    async with household_session(a.household_id) as db:
        await db.execute(
            text("UPDATE sessions SET revealed_at = now() - interval '31 seconds' WHERE id = :s"),
            {"s": a.ids["session"]},
        )
    async with phone() as host:
        await _host(host, a)
        resp = await _put(host, _url(a), True)
    assert resp.status_code == 200, resp.text
    assert (await _row(a)).status == "tonight"


@pytest.mark.parametrize("status", ["draft", "voting", "revealed"])
async def test_before_the_pick_it_is_a_409(two_households: Pair, status: str) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, status)
    async with household_session(a.household_id) as db:
        await db.execute(
            text("UPDATE sessions SET revealed_at = now() WHERE id = :s"), {"s": a.ids["session"]}
        )
    async with phone() as host:
        await _host(host, a)
        resp = await _put(host, _url(a), True)
    assert resp.status_code == 409
    assert "slideshow starts" in resp.json()["error"]["message"]
    row = await _row(a)
    assert row.slideshow_started_at is None and row.slideshow_stopped_at is None
    assert await _actions(a) == []


async def test_a_device_reads_the_mode_but_cannot_change_it(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, "voting")
    async with phone() as kid:
        assert (await kid.join(a.slug, CODE)).status_code == 200
        await open_night(a.household_id, a.ids["session"], CODE, "tonight")
        assert (await kid.client.get(f"{BASE}/{a.ids['session']}")).json()["slideshow"] == "auto"
        resp = await _put(kid, _url(a), True)
    assert resp.status_code == 401
    assert (await _row(a)).slideshow_started_at is None
    assert await _actions(a) == []


async def test_it_needs_the_csrf_header(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, "tonight")
    async with phone() as host:
        await _host(host, a)
        await host.csrf()  # the cookie is present; only the header is missing
        resp = await _put(host, _url(a), True, csrf=False)
    assert resp.status_code == 403
    assert "CSRF" in resp.json()["error"]["message"]
    assert (await _row(a)).slideshow_started_at is None


async def test_another_households_night_is_a_404(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE, "tonight")
    async with phone() as host:
        await _host(host, b)
        assert (await _put(host, _url(a), True)).status_code == 404
        assert (await _put(host, _url(a), False)).status_code == 404
    row = await _row(a)
    assert row.slideshow_started_at is None and row.slideshow_stopped_at is None
    assert await _actions(a) == []


async def test_the_database_refuses_both_states_at_once(two_households: Pair) -> None:
    a, _ = two_households
    with pytest.raises(Exception, match="slideshow_one_state"):
        async with household_session(a.household_id) as db:
            await db.execute(
                text(
                    "UPDATE sessions SET slideshow_started_at = now(), "
                    "slideshow_stopped_at = now() WHERE id = :s"
                ),
                {"s": a.ids["session"]},
            )
