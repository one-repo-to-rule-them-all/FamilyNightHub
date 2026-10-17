"""Who's here tonight (guest-flow spec G8): session_attendance, GET …/present and the
`presence` hint; plus the G4 counts (TV help-count, admin open PIN-reset count)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.realtime import events
from app.services import attendance_service
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "HERE23"


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Every `presence` hint the attendance service queues (after-commit publishes)."""
    seen: list[str] = []

    def record(db: Any, session_id: uuid.UUID, event_type: str) -> None:
        seen.append(event_type)

    monkeypatch.setattr(attendance_service, "publish_after_commit", record)
    yield seen


async def _person(h: SeededHousehold, name: str, guest: bool = False) -> uuid.UUID:
    async with household_session(h.household_id) as db:
        pid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color, is_guest) "
                    "VALUES (:h, :n, '🐼', '#22c55e', :g) RETURNING id"
                ),
                {"h": h.household_id, "n": f"{name} {uuid.uuid4().hex[:6]}", "g": guest},
            )
        ).scalar_one()
    return pid


async def _night(h: SeededHousehold, status: str = "voting") -> str:
    """The seeded night, live, with its code. The seed's own attendance row is cleared so each
    test starts from nobody here (the seed's ballot would count Kid as a voter, too)."""
    await open_night(h.household_id, h.ids["session"], CODE, status=status)
    async with household_session(h.household_id) as db:
        await db.execute(text("DELETE FROM session_attendance"))
        await db.execute(text("DELETE FROM ballot_ranks"))
    return str(h.ids["session"])


async def _phone_as(p: Phone, h: SeededHousehold, person: uuid.UUID) -> None:
    assert (await p.join(h.slug, CODE)).status_code == 200
    assert (await p.bind(person)).json()["current"] is True


async def _ticket(p: Phone, sid: str) -> Response:
    return await p.client.post(
        "/api/v1/sse-tickets", json={"session_id": sid}, headers={CSRF_HEADER: await p.csrf()}
    )


async def _vote(
    p: Phone, sid: str, person: uuid.UUID, option: uuid.UUID, proxy: bool = False
) -> Response:
    path = f"/api/v1/sessions/{sid}/ballots" + ("/proxy" if proxy else "")
    body = {"person_id": str(person), "ranks": [{"option_id": str(option), "rank": 1}]}
    return await p.client.put(path, json=body, headers={CSRF_HEADER: await p.csrf()})


async def _present(p: Phone, sid: str) -> dict[str, dict[str, Any]]:
    resp = await p.client.get(f"/api/v1/sessions/{sid}/present")
    assert resp.status_code == 200, resp.text
    return {row["person_id"]: row for row in resp.json()["present"]}


async def _rows(h: SeededHousehold) -> int:
    async with household_session(h.household_id) as db:
        count: int = await db.scalar(text("SELECT count(*) FROM session_attendance"))
    return count


# --- G8: who's here --------------------------------------------------------------------


async def test_opening_the_night_on_a_phone_marks_its_person_here_once(
    two_households: Pair, published: list[str]
) -> None:
    a, _ = two_households
    sid = await _night(a)
    sam = await _person(a, "Sam")
    async with phone() as p:
        await _phone_as(p, a, sam)
        assert (await _ticket(p, sid)).status_code == 201
        assert (await _ticket(p, sid)).status_code == 201  # re-ticketing: nothing new
        here = await _present(p, sid)
    assert here == {
        str(sam): {"person_id": str(sam), "avatar_emoji": "🐼", "color": "#22c55e", "voted": False}
    }
    assert published == [events.PRESENCE]
    assert await _rows(a) == 1


async def test_voters_and_proxy_voters_are_here_with_no_ranks(
    two_households: Pair, published: list[str]
) -> None:
    a, _ = two_households
    sid = await _night(a)
    ana, kid = await _person(a, "Ana"), a.ids["person"]
    async with phone() as p, phone() as host:
        await _phone_as(p, a, ana)
        host.sign_in_as(a.ids["account"], a.household_id)
        assert (await _vote(p, sid, ana, a.ids["option"])).status_code == 204
        assert (await _vote(host, sid, kid, a.ids["option2"], proxy=True)).status_code == 204
        resp = await host.client.get(f"/api/v1/sessions/{sid}/present")
    rows = {r["person_id"]: r for r in resp.json()["present"]}
    assert {k: v["voted"] for k, v in rows.items()} == {str(ana): True, str(kid): True}
    # Presence never carries how anyone voted.
    for row in resp.json()["present"]:
        assert set(row) == {"person_id", "avatar_emoji", "color", "voted"}
    for leak in ("option_id", "rank", "score", str(a.ids["option"]), str(a.ids["option2"])):
        assert leak not in resp.text
    # The phone voter got a row (and a hint); the proxy voter shows through the ballot only.
    assert published == [events.PRESENCE]
    assert await _rows(a) == 1


async def test_a_phone_not_set_to_anyone_marks_nobody(
    two_households: Pair, published: list[str]
) -> None:
    a, _ = two_households
    sid = await _night(a)
    async with phone() as p:
        assert (await p.join(a.slug, CODE)).status_code == 200
        # Claiming someone another phone holds, without a PIN: pending, not current.
        assert (await p.bind(a.ids["person"], pin=None)).json()["status"] == "pending"
        assert (await _ticket(p, sid)).status_code == 201
        here = await _present(p, sid)
    assert here == {}
    assert published == []


async def test_a_closed_night_records_nobody(two_households: Pair, published: list[str]) -> None:
    a, _ = two_households
    sid = await _night(a)
    sam = await _person(a, "Sam")
    async with phone() as p:
        await _phone_as(p, a, sam)
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE sessions SET status = 'closed' WHERE id = :s"), {"s": sid}
            )
        assert (await _ticket(p, sid)).status_code == 201
        here = await _present(p, sid)
    assert here == {}
    assert published == []


async def test_present_is_household_scoped(two_households: Pair) -> None:
    a, b = two_households
    await _night(a)
    async with phone() as p, phone() as nobody, phone() as admin:
        await _phone_as(p, a, await _person(a, "Sam"))
        admin.sign_in_as(a.ids["account"], a.household_id)
        theirs = await p.client.get(f"/api/v1/sessions/{b.ids['session']}/present")
        theirs_admin = await admin.client.get(f"/api/v1/sessions/{b.ids['session']}/present")
        missing = await p.client.get(f"/api/v1/sessions/{uuid.uuid4()}/present")
        anonymous = await nobody.client.get(f"/api/v1/sessions/{a.ids['session']}/present")
    assert (theirs.status_code, theirs_admin.status_code, missing.status_code) == (404, 404, 404)
    assert anonymous.status_code == 401


async def test_merging_people_merges_their_attendance(two_households: Pair) -> None:
    a, _ = two_households
    sid = await _night(a)
    guest, member = await _person(a, "Gran", guest=True), await _person(a, "Grandma")
    async with phone() as p, phone() as q, phone() as admin:
        await _phone_as(p, a, guest)
        await _phone_as(q, a, member)
        await _ticket(p, sid)
        await _ticket(q, sid)
        admin.sign_in_as(a.ids["account"], a.household_id)
        merged = await admin.post(
            "/api/v1/admin/people/merge",
            {"from_person_id": str(guest), "into_person_id": str(member)},
        )
        here = await _present(admin, sid)
    assert merged.status_code == 200
    assert list(here) == [str(member)]
    assert await _rows(a) == 1


# --- G4: counts ------------------------------------------------------------------------


async def _make_tv(p: Phone, h: SeededHousehold) -> None:
    resp = await p.join(h.slug, CODE)
    assert resp.status_code == 200
    async with household_session(h.household_id) as db:
        await db.execute(
            text("UPDATE devices SET is_tv = true WHERE id = :d"),
            {"d": uuid.UUID(resp.json()["device_id"])},
        )


async def test_the_tv_counts_pending_claims_only(two_households: Pair) -> None:
    a, b = two_households
    await _night(a)
    await open_night(b.household_id, b.ids["session"], CODE)
    async with phone() as tv, phone() as claimer, phone() as plain, phone() as b_claimer:
        await _make_tv(tv, a)
        before = (await tv.client.get("/api/v1/devices/me/help-count")).json()
        assert (await claimer.join(a.slug, CODE)).status_code == 200
        # The seed's Kid is held by the seeded device: a claim without a PIN waits for a host.
        assert (await claimer.bind(a.ids["person"], pin=None)).json()["status"] == "pending"
        # Household b's pending claim never counts for a's TV.
        assert (await b_claimer.join(b.slug, CODE)).status_code == 200
        assert (await b_claimer.bind(b.ids["person"], pin=None)).json()["status"] == "pending"
        after = (await tv.client.get("/api/v1/devices/me/help-count")).json()
        assert (await plain.join(a.slug, CODE)).status_code == 200
        phone_resp = await plain.client.get("/api/v1/devices/me/help-count")
    # The seed also has an open PIN reset for Kid: resets are not counted here.
    assert before == {"count": 0, "first_name": None}
    assert after == {"count": 1, "first_name": "Kid"}
    assert phone_resp.status_code == 403


async def test_admins_get_the_open_reset_count_and_hosts_do_not(two_households: Pair) -> None:
    a, b = two_households
    host_id = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@x.test")
    async with phone() as admin, phone() as host:
        admin.sign_in_as(a.ids["account"], a.household_id)
        host.sign_in_as(host_id, a.household_id)
        seeded = (await admin.client.get("/api/v1/admin/people/pin-resets/count")).json()
        await admin.post(f"/api/v1/admin/people/pin-resets/{a.ids['pin_reset_request']}/dismiss")
        after = (await admin.client.get("/api/v1/admin/people/pin-resets/count")).json()
        host_count = await host.client.get("/api/v1/admin/people/pin-resets/count")
        host_list = await host.client.get("/api/v1/admin/people/pin-resets")
        host_approve = await host.post(
            f"/api/v1/admin/people/pin-resets/{a.ids['pin_reset_request']}/approve"
        )
    # Household b's open request (from its own seed) never shows in a's count.
    assert seeded == {"open_count": 1}
    assert after == {"open_count": 0}
    assert (host_count.status_code, host_list.status_code, host_approve.status_code) == (
        403,
        403,
        403,
    )
