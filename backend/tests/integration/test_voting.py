"""Voting: ballots, proxy votes, who-has-voted, close + reveal, close, history (ADR-0006)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.api.v1 import sessions as sessions_api
from app.core import permissions
from app.core.config import settings
from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.services import session_service
from tests.integration.phones import TEST_PIN, Phone, add_account, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"
SEED_HEADER = "X-FNH-Test-Seed"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The seed header is honoured only in ENVIRONMENT=test; pin it whatever the shell says."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


# --- Helpers ---------------------------------------------------------------------------


async def _send(
    p: Phone, method: str, path: str, body: Any = None, *, csrf: bool = True, **headers: str
) -> Response:
    if csrf:
        headers[CSRF_HEADER] = await p.csrf()
    return await p.client.request(method, path, json=body, headers=headers)


async def _host(p: Phone, h: SeededHousehold) -> uuid.UUID:
    account = await add_account(h.household_id, "host", f"host.{uuid.uuid4().hex[:10]}@ex.test")
    p.sign_in_as(account, h.household_id)
    return account


async def _night(host: Phone, n: int, *, open_voting: bool = True) -> tuple[str, str, list[str]]:
    """A night with n typed titles: (session id, night code, option ids in order)."""
    created = (await host.post(BASE, {"title": "Friday"})).json()
    sid = created["session_id"]
    for i in range(n):
        resp = await host.post(
            f"{BASE}/{sid}/options", {"title": f"Title {uuid.uuid4().hex[:6]} {i}"}
        )
        assert resp.status_code == 201, resp.text
    if open_voting:
        assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
    snap = (await host.client.get(f"{BASE}/{sid}")).json()
    return sid, created["night_code"], [o["id"] for o in snap["options"]]


async def _person(h: SeededHousehold, name: str = "Sam", emoji: str = "🐙") -> uuid.UUID:
    async with household_session(h.household_id) as db:
        pid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, :n, :e, '#22c55e') RETURNING id"
                ),
                {"h": h.household_id, "n": name, "e": emoji},
            )
        ).scalar_one()
    return pid


async def _phone_for(
    p: Phone, h: SeededHousehold, code: str, person: uuid.UUID, pin: str | None = TEST_PIN
) -> str:
    assert (await p.join(h.slug, code)).status_code == 200
    resp = await p.bind(person, pin)
    assert resp.status_code == 200, resp.text
    status: str = resp.json()["status"]
    return status


def _ballot(person: uuid.UUID, *option_ids: str) -> dict[str, Any]:
    return {
        "person_id": str(person),
        "ranks": [{"option_id": o, "rank": r} for r, o in enumerate(option_ids, start=1)],
    }


async def _vote(p: Phone, sid: str, person: uuid.UUID, *option_ids: str) -> Response:
    return await _send(p, "PUT", f"{BASE}/{sid}/ballots", _ballot(person, *option_ids))


async def _proxy(p: Phone, sid: str, person: uuid.UUID, *option_ids: str) -> Response:
    return await _send(p, "PUT", f"{BASE}/{sid}/ballots/proxy", _ballot(person, *option_ids))


async def _close_voting(p: Phone, sid: str, seed: int | str | None = 42) -> Response:
    headers = {} if seed is None else {SEED_HEADER: str(seed)}
    return await _send(p, "POST", f"{BASE}/{sid}/close-voting", **headers)


async def _rows(h: SeededHousehold, sql: str, **params: Any) -> list[Any]:
    async with household_session(h.household_id) as db:
        return list(await db.execute(text(sql), params))


async def _ballot_rows(h: SeededHousehold, sid: str) -> list[Any]:
    return await _rows(
        h,
        "SELECT person_id, option_id, rank, cast_by_device_id, cast_by_account_id, is_proxy "
        "FROM ballot_ranks WHERE session_id = :s ORDER BY person_id, rank",
        s=sid,
    )


async def _actions(h: SeededHousehold, sid: str) -> list[str]:
    rows = await _rows(
        h, "SELECT action FROM audit_events WHERE target_id = :s ORDER BY created_at", s=sid
    )
    return [r.action for r in rows]


# --- Casting ---------------------------------------------------------------------------


async def test_a_phone_votes_and_can_replace_its_ballot(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, o2, o3, _o4) = await _night(host, 4)
        assert await _phone_for(kid, a, code, sam) == "active"

        resp = await _vote(kid, sid, sam, o1, o2, o3)
        assert resp.status_code == 204, resp.text
        resp = await _vote(kid, sid, sam, o3)  # changed my mind: o3 only
        assert resp.status_code == 204, resp.text
        mine = (await kid.client.get(f"{BASE}/{sid}/ballots/mine")).json()

    rows = await _ballot_rows(a, sid)
    assert [(str(r.option_id), r.rank, r.is_proxy, r.cast_by_account_id) for r in rows] == [
        (o3, 1, False, None)
    ]
    assert rows[0].cast_by_device_id is not None
    assert mine == [{"person_id": str(sam), "ranks": [{"option_id": o3, "rank": 1}]}]


async def test_a_phone_reads_back_only_its_own_peoples_ballots(two_households: Pair) -> None:
    a, _ = two_households
    sam, ana, max_ = await _person(a, "Sam"), await _person(a, "Ana"), await _person(a, "Max")
    async with phone() as host, phone() as shared, phone() as other:
        await _host(host, a)
        sid, code, (o1, o2, _o3) = await _night(host, 3)
        await _phone_for(shared, a, code, sam)
        assert (await _vote(shared, sid, sam, o1, o2)).status_code == 204
        # ADR-0014: the shared phone switches to Ana (with her PIN); now it is Ana's turn.
        assert (await shared.bind(ana)).json()["status"] == "active"
        not_sams_turn = await _vote(shared, sid, sam, o2)
        await _phone_for(other, a, code, max_)
        assert (await _vote(other, sid, max_, o2)).status_code == 204
        mine = (await shared.client.get(f"{BASE}/{sid}/ballots/mine")).json()

    assert not_sams_turn.status_code == 403
    by_person = {b["person_id"]: b["ranks"] for b in mine}
    assert by_person == {
        str(sam): [{"option_id": o1, "rank": 1}, {"option_id": o2, "rank": 2}],
        str(ana): [],
    }


async def test_a_phone_cannot_vote_as_someone_bound_only_to_another_phone(
    two_households: Pair,
) -> None:
    a, _ = two_households
    sam, ana = await _person(a, "Sam"), await _person(a, "Ana")
    async with phone() as host, phone() as sams, phone() as anas:
        await _host(host, a)
        sid, code, (o1, _o2) = await _night(host, 2)
        await _phone_for(sams, a, code, sam)
        await _phone_for(anas, a, code, ana)
        resp = await _vote(anas, sid, sam, o1)
        # Not bound at all: a free person nobody claimed.
        nobody = await _person(a, "Zed")
        resp_free = await _vote(anas, sid, nobody, o1)
    assert resp.status_code == 403
    assert resp_free.status_code == 403
    assert await _ballot_rows(a, sid) == []


async def test_a_pending_claim_cannot_vote(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as first, phone() as second:
        await _host(host, a)
        sid, code, (o1, _o2) = await _night(host, 2)
        assert await _phone_for(first, a, code, sam) == "active"
        # No PIN: the host-approval path (ADR-0014's admin override).
        assert await _phone_for(second, a, code, sam, pin=None) == "pending"
        resp = await _vote(second, sid, sam, o1)
        mine = (await second.client.get(f"{BASE}/{sid}/ballots/mine")).json()
    assert resp.status_code == 403
    assert mine == []
    assert await _ballot_rows(a, sid) == []


async def test_ballots_only_while_voting(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, opts = await _night(host, 2, open_voting=False)
        await _phone_for(kid, a, code, sam)
        draft = await _vote(kid, sid, sam, opts[0])
        draft_proxy = await _proxy(host, sid, sam, opts[0])
        assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
        assert (await _vote(kid, sid, sam, opts[0])).status_code == 204
        assert (await _close_voting(host, sid)).status_code == 200
        late = await _vote(kid, sid, sam, opts[1])
        late_proxy = await _proxy(host, sid, sam, opts[1])
    assert (draft.status_code, draft_proxy.status_code) == (409, 409)
    assert (late.status_code, late_proxy.status_code) == (409, 409)
    assert "not open" in late.json()["error"]["message"]
    rows = await _ballot_rows(a, sid)
    assert [(str(r.option_id), r.rank) for r in rows] == [(opts[0], 1)]


@pytest.mark.parametrize(
    "case", ["rank_beyond_k", "gap", "same_option_twice", "foreign_option", "too_many", "empty"]
)
async def test_ballots_that_break_the_rules_are_422(two_households: Pair, case: str) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, o2, o3) = await _night(host, 3)  # k = 2
        _, _, (other_night_option, _x) = await _night(host, 2)
        await _phone_for(kid, a, code, sam)
        ranks = {
            "rank_beyond_k": [(o1, 1), (o2, 2), (o3, 3)],
            "gap": [(o1, 2)],
            "same_option_twice": [(o1, 1), (o1, 2)],
            "foreign_option": [(other_night_option, 1)],
            "too_many": [(o1, 1), (o2, 2), (o3, 3), (o1, 4)],
            "empty": [],
        }[case]
        body = {
            "person_id": str(sam),
            "ranks": [{"option_id": o, "rank": r} for o, r in ranks],
        }
        resp = await _send(kid, "PUT", f"{BASE}/{sid}/ballots", body)
    assert resp.status_code == 422, resp.text
    assert await _ballot_rows(a, sid) == []


# --- Proxy -----------------------------------------------------------------------------


async def test_a_host_proxy_votes_for_a_kid_without_a_phone(two_households: Pair) -> None:
    a, _ = two_households
    toddler = await _person(a, "Toddler", "🐣")
    async with phone() as host:
        account = await _host(host, a)
        sid, _code, (o1, o2) = await _night(host, 2)
        assert (await _proxy(host, sid, toddler, o2)).status_code == 204
        assert (await _proxy(host, sid, toddler, o1)).status_code == 204  # replaceable
        unknown = await _proxy(host, sid, uuid.uuid4(), o1)
    rows = await _ballot_rows(a, sid)
    assert [
        (str(r.option_id), r.is_proxy, r.cast_by_account_id, r.cast_by_device_id) for r in rows
    ] == [(o1, True, account, None)]
    assert unknown.status_code == 404
    assert (await _actions(a, sid)).count("ballot.proxy_cast") == 2
    data = await _rows(
        a,
        "SELECT data FROM audit_events WHERE action = 'ballot.proxy_cast' AND target_id = :s",
        s=sid,
    )
    assert all(r.data == {"person_id": str(toddler)} for r in data)  # who, never what


async def test_proxy_needs_the_permission(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    toddler = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, _o2) = await _night(host, 2)
        monkeypatch.setitem(
            permissions.ROLE_PERMISSIONS,
            "host",
            permissions.ROLE_PERMISSIONS["host"] - {"ballots:proxy"},
        )
        no_permission = await _proxy(host, sid, toddler, o1)
        assert (await kid.join(a.slug, code)).status_code == 200
        device_only = await _proxy(kid, sid, toddler, o1)
    assert no_permission.status_code == 403
    assert device_only.status_code == 401
    assert await _ballot_rows(a, sid) == []


async def test_a_host_without_a_device_cannot_use_the_phone_route(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, _o2) = await _night(host, 2)
        assert (await _vote(host, sid, sam, o1)).status_code == 401


# --- Who has voted ---------------------------------------------------------------------


async def test_everyone_sees_who_voted_but_never_what(two_households: Pair) -> None:
    a, _ = two_households
    sam, ana = await _person(a, "Sam", "🐙"), await _person(a, "Ana", "🦊")
    async with phone() as host, phone() as kid, phone() as tv:
        await _host(host, a)
        sid, code, (o1, o2, o3) = await _night(host, 3)
        await _phone_for(kid, a, code, sam)
        assert (await tv.join(a.slug, code)).status_code == 200
        empty = (await tv.client.get(f"{BASE}/{sid}/voters")).json()
        assert (await _vote(kid, sid, sam, o3, o1)).status_code == 204
        assert (await _proxy(host, sid, ana, o2)).status_code == 204
        tv_view = await tv.client.get(f"{BASE}/{sid}/voters")
        host_view = await host.client.get(f"{BASE}/{sid}/voters")
        snap = await tv.client.get(f"{BASE}/{sid}")
    assert empty == {"voted": []}
    assert tv_view.json() == host_view.json()
    voted = tv_view.json()["voted"]
    assert {v["person_id"] for v in voted} == {str(sam), str(ana)}
    assert all(set(v) == {"person_id", "avatar_emoji", "color"} for v in voted)
    # Tallies are hidden until reveal: no ranks, scores or result anywhere.
    for resp in (tv_view, snap):
        for leak in ('"rank"', "score", "placements", "winner", "tie_seed"):
            assert leak not in resp.text, leak
    assert not any(o in tv_view.text for o in (o1, o2, o3))
    assert snap.json()["result"] is None


# --- Close voting + reveal -------------------------------------------------------------


async def test_close_voting_tallies_and_reveals(two_households: Pair) -> None:
    a, _ = two_households
    p1, p2, p3 = await _person(a, "P1"), await _person(a, "P2"), await _person(a, "P3")
    async with phone() as host:
        account = await _host(host, a)
        sid, _code, (o1, o2, o3, o4) = await _night(host, 4)  # k = 3
        assert (await _proxy(host, sid, p1, o2, o1, o3)).status_code == 204
        assert (await _proxy(host, sid, p2, o2, o3)).status_code == 204
        assert (await _proxy(host, sid, p3, o1)).status_code == 204
        resp = await _close_voting(host, sid, seed=987654321)
    assert resp.status_code == 200, resp.text
    snap = resp.json()
    assert snap["status"] == "revealed" and snap["revealed_at"] is not None
    result = snap["result"]
    # o2 = 3 + 3, o1 = 2 + 3, o3 = 1 + 2, o4 = 0.
    assert [(p["option_id"], p["score"], p["place"]) for p in result["placements"]] == [
        (o2, 6, 1),
        (o1, 5, 2),
        (o3, 3, 3),
        (o4, 0, 4),
    ]
    assert result["winner_option_id"] == o2
    assert (result["tiebreak"], result["tie_group"], result["ballot_count"]) == ("none", [o2], 3)
    assert result["tie_seed"] == "987654321"

    row = (await _rows(a, "SELECT * FROM sessions WHERE id = :s", s=sid))[0]
    assert str(row.winner_option_id) == o2 and int(row.tie_seed) == 987654321
    assert row.ranking["placements"][0]["option_id"] == o2 and row.status == "revealed"
    audit = await _rows(
        a,
        "SELECT actor_account_id, data FROM audit_events "
        "WHERE target_id = :s AND action = 'session.voting_closed'",
        s=sid,
    )
    assert [(r.actor_account_id, r.data) for r in audit] == [
        (
            account,
            {
                "from": "voting",
                "to": "revealed",
                "ballots": 3,
                "winner_option_id": o2,
                "tiebreak": "none",
            },
        )
    ]


async def test_a_phone_sees_the_result_only_after_reveal(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, _o2) = await _night(host, 2)
        await _phone_for(kid, a, code, sam)
        assert (await _vote(kid, sid, sam, o1)).status_code == 204
        before = (await kid.client.get(f"{BASE}/{sid}")).json()
        assert (await _close_voting(host, sid)).status_code == 200
        after = (await kid.client.get(f"{BASE}/{sid}")).json()
    assert before["result"] is None
    assert after["result"]["winner_option_id"] == o1


async def test_a_seeded_tie_reproduces_and_zero_ballots_still_pick(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        winners = []
        for _ in range(2):
            sid, _code, opts = await _night(host, 3)
            resp = (await _close_voting(host, sid, seed=7)).json()
            assert resp["result"]["tiebreak"] == "random"
            assert resp["result"]["ballot_count"] == 0
            assert set(resp["result"]["tie_group"]) == set(opts)
            winners.append(resp["result"]["winner_option_id"] in opts)
    assert winners == [True, True]


async def test_close_voting_is_idempotent(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, o2, o3) = await _night(host, 3)
        assert (await _proxy(host, sid, sam, o3)).status_code == 204
        first = await _close_voting(host, sid, seed=1)
        again = await _close_voting(host, sid, seed=2)
    assert first.status_code == again.status_code == 200
    assert first.json()["result"] == again.json()["result"]
    assert again.json()["result"]["tie_seed"] == "1"
    assert (await _actions(a, sid)).count("session.voting_closed") == 1


async def test_close_voting_needs_an_open_vote(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2, open_voting=False)
        resp = await _close_voting(host, sid)
    assert resp.status_code == 409
    row = (await _rows(a, "SELECT status, ranking FROM sessions WHERE id = :s", s=sid))[0]
    assert (row.status, row.ranking) == ("draft", None)


async def _blocked_on(holder_pid: int, h: SeededHousehold) -> None:
    """Return once some backend waits on a lock held by `holder_pid` (no sleeps: each poll
    is a round trip that yields to the request under test)."""
    for _ in range(2000):
        rows = await _rows(
            h,
            "SELECT 1 FROM pg_locks WHERE NOT granted AND :pid = ANY(pg_blocking_pids(pid))",
            pid=holder_pid,
        )
        if rows:
            return
    raise AssertionError("the second close never waited on the first")


async def test_two_hosts_closing_at_once_get_one_result(two_households: Pair) -> None:
    """Deterministic race: host 1's close holds its transaction open until host 2's close is
    provably waiting on it. The row lock must turn host 2's close into a no-op."""
    a, _ = two_households
    async with phone() as host1, phone() as host2:
        first = await _host(host1, a)
        await _host(host2, a)
        sid, _code, _opts = await _night(host1, 5)  # zero ballots: the seed decides
        await host2.csrf()
        async with household_session(a.household_id) as db:
            holder: int = await db.scalar(text("SELECT pg_backend_pid()"))
            await session_service.close_voting(db, a.household_id, first, uuid.UUID(sid), seed=111)
            second = asyncio.create_task(_close_voting(host2, sid, seed=222))
            await _blocked_on(holder, a)
        r2 = await second
        r1 = await host1.client.get(f"{BASE}/{sid}")
    assert r2.status_code == 200, r2.text
    assert r2.json()["result"] == r1.json()["result"]
    assert r2.json()["result"]["tie_seed"] == "111"
    assert (await _actions(a, sid)).count("session.voting_closed") == 1


async def test_close_voting_is_host_only(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, _opts = await _night(host, 2)
        assert (await kid.join(a.slug, code)).status_code == 200
        assert (await _close_voting(kid, sid)).status_code == 401
        assert (await _send(kid, "POST", f"{BASE}/{sid}/close")).status_code == 401


# --- The test-only seed header ---------------------------------------------------------


async def test_the_seed_header_is_ignored_outside_test(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(sessions_api.secrets, "randbits", lambda bits: 31337)
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2)
        resp = await _close_voting(host, sid, seed=5)
    assert resp.json()["result"]["tie_seed"] == "31337"


async def test_without_the_header_the_seed_is_random(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    calls: list[int] = []
    monkeypatch.setattr(sessions_api.secrets, "randbits", lambda bits: calls.append(bits) or 77)
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2)
        resp = await _close_voting(host, sid, seed=None)
    assert resp.json()["result"]["tie_seed"] == "77" and calls == [64]


@pytest.mark.parametrize("bad", ["abc", "-1", str(2**64)])
async def test_a_bad_test_seed_is_422(two_households: Pair, bad: str) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2)
        resp = await _close_voting(host, sid, seed=bad)
    assert resp.status_code == 422
    assert (await _rows(a, "SELECT status FROM sessions WHERE id = :s", s=sid))[
        0
    ].status == "voting"


# --- revealed -> tonight -> closed -----------------------------------------------------


async def test_tonight_is_lazy_and_the_next_write_persists_it(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, code, _opts = await _night(host, 2)
        assert (await _close_voting(host, sid)).status_code == 200
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE sessions SET revealed_at = now() - interval '1 minute' WHERE id = :s"),
                {"s": sid},
            )
        assert (await host.client.get(f"{BASE}/{sid}")).json()["status"] == "tonight"
        stored = (await _rows(a, "SELECT status FROM sessions WHERE id = :s", s=sid))[0].status
        closed = await _send(host, "POST", f"{BASE}/{sid}/close")
        closed_again = await _send(host, "POST", f"{BASE}/{sid}/close")
    assert stored == "revealed"  # reading never writes
    assert closed.status_code == closed_again.status_code == 200
    body = closed.json()
    assert body["status"] == "closed" and body["closed_at"] is not None
    assert body["result"] is not None  # history keeps the result
    actions = await _actions(a, sid)
    # Both rows come from one transaction, so they share created_at (now() is the
    # transaction start) and their relative order is not observable. Assert presence.
    assert sorted(actions[-2:]) == ["session.closed", "session.settled"]
    assert actions.count("session.closed") == 1
    assert actions.count("session.settled") == 1
    async with phone() as late:
        assert (await late.join(a.slug, code)).status_code == 400  # the code is released


async def test_end_the_night_right_after_the_reveal_takes_one_tap(two_households: Pair) -> None:
    """Issue #69: inside the settle window the stored status is still `revealed`; End the night
    must close it directly instead of answering 409 until the reveal settles."""
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, code, _opts = await _night(host, 2)
        assert (await _close_voting(host, sid)).status_code == 200
        assert (await host.client.get(f"{BASE}/{sid}")).json()["status"] == "revealed"
        closed = await _send(host, "POST", f"{BASE}/{sid}/close")
    assert closed.status_code == 200
    body = closed.json()
    assert body["status"] == "closed" and body["closed_at"] is not None
    assert body["result"] is not None
    assert (await _rows(a, "SELECT status FROM sessions WHERE id = :s", s=sid))[
        0
    ].status == "closed"
    actions = await _actions(a, sid)
    assert actions.count("session.closed") == 1
    assert "session.settled" not in actions  # closed straight from revealed
    async with phone() as late:
        assert (await late.join(a.slug, code)).status_code == 400


async def test_any_later_write_persists_the_settle(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2)
        assert (await _close_voting(host, sid)).status_code == 200
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE sessions SET revealed_at = now() - interval '1 minute' WHERE id = :s"),
                {"s": sid},
            )
        assert (await host.post(f"{BASE}/{sid}/night-code")).status_code == 200
        assert (await _close_voting(host, sid)).status_code == 200  # still a no-op
    assert (await _rows(a, "SELECT status FROM sessions WHERE id = :s", s=sid))[
        0
    ].status == "tonight"
    assert (await _actions(a, sid)).count("session.settled") == 1


# --- History ---------------------------------------------------------------------------


async def test_history_lists_past_nights_with_winner_and_turnout(two_households: Pair) -> None:
    a, b = two_households
    p1, p2 = await _person(a, "P1"), await _person(a, "P2")
    async with phone() as host, phone() as kid, phone() as b_host:
        await _host(host, a)
        await _host(b_host, b)
        older, code, (o1, _o2) = await _night(host, 2)
        assert (await _proxy(host, older, p1, o1)).status_code == 204
        assert (await _proxy(host, older, p2, o1)).status_code == 204
        assert (await _close_voting(host, older)).status_code == 200
        newer, _c, (_n1, n2, _n3) = await _night(host, 3)
        assert (await _proxy(host, newer, p1, n2)).status_code == 204
        assert (await _close_voting(host, newer)).status_code == 200
        still_voting, _c2, _opts = await _night(host, 2)
        b_night, _c3, _b_opts = await _night(b_host, 2)
        assert (await _close_voting(b_host, b_night)).status_code == 200

        assert (await kid.join(a.slug, code)).status_code == 200
        listed = (await kid.client.get(BASE)).json()
        voting_only = (await host.client.get(BASE, params={"status": "voting"})).json()
        one = (await host.client.get(BASE, params={"limit": 1})).json()
        bad = await host.client.get(BASE, params={"status": "nope"})

    ids = [n["id"] for n in listed]
    assert ids[:2] == [newer, older]
    assert still_voting not in ids and b_night not in ids
    newest, oldest = listed[0], listed[1]
    assert newest["winner"]["option_id"] == n2 and newest["turnout"] == 1
    assert oldest["winner"]["option_id"] == o1 and oldest["turnout"] == 2
    assert set(oldest["winner"]) == {"option_id", "movie_id", "title", "year", "poster_path"}
    assert oldest["winner"]["title"].startswith("Title ")
    assert [n["id"] for n in voting_only if n["id"] == still_voting] == [still_voting]
    assert all(n["winner"] is None and n["status"] == "voting" for n in voting_only)
    assert [n["id"] for n in one] == [newer]
    assert bad.status_code == 422


async def test_history_filters_on_the_status_readers_see(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2)
        assert (await _close_voting(host, sid)).status_code == 200
        revealed = [
            n["id"] for n in (await host.client.get(BASE, params={"status": "revealed"})).json()
        ]
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE sessions SET revealed_at = now() - interval '1 minute' WHERE id = :s"),
                {"s": sid},
            )
        tonight = (await host.client.get(BASE, params={"status": "tonight"})).json()
        revealed_after = [
            n["id"] for n in (await host.client.get(BASE, params={"status": "revealed"})).json()
        ]
    assert sid in revealed
    assert [n["status"] for n in tonight if n["id"] == sid] == ["tonight"]
    assert sid not in revealed_after


async def test_nobody_reads_history_without_a_credential(two_households: Pair) -> None:
    async with phone() as stranger:
        assert (await stranger.client.get(BASE)).status_code == 401


# --- Isolation and CSRF ----------------------------------------------------------------


async def test_another_household_gets_404_everywhere(two_households: Pair) -> None:
    a, b = two_households
    sam = await _person(a)
    b_kid = await _person(b, "Bee")
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, _o2) = await _night(host, 2)
        assert (await _proxy(host, sid, sam, o1)).status_code == 204
    async with phone() as b_host, phone() as b_phone:
        await _host(b_host, b)
        _b_sid, b_code, _b_opts = await _night(b_host, 2)
        await _phone_for(b_phone, b, b_code, b_kid)
        assert (await _vote(b_phone, sid, b_kid, o1)).status_code == 404
        assert (await _proxy(b_host, sid, b_kid, o1)).status_code == 404
        assert (await _proxy(b_host, sid, sam, o1)).status_code == 404
        assert (await b_phone.client.get(f"{BASE}/{sid}/voters")).status_code == 404
        assert (await b_phone.client.get(f"{BASE}/{sid}/ballots/mine")).status_code == 404
        assert (await _close_voting(b_host, sid)).status_code == 404
        assert (await _send(b_host, "POST", f"{BASE}/{sid}/close")).status_code == 404
        b_history = (await b_phone.client.get(BASE, params={"status": "voting"})).json()
    assert sid not in [n["id"] for n in b_history]
    rows = await _ballot_rows(a, sid)
    assert [r.person_id for r in rows] == [sam]
    assert (await _rows(a, "SELECT status FROM sessions WHERE id = :s", s=sid))[
        0
    ].status == "voting"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("PUT", "/{sid}/ballots"),
        ("PUT", "/{sid}/ballots/proxy"),
        ("POST", "/{sid}/close-voting"),
        ("POST", "/{sid}/close"),
    ],
)
async def test_every_voting_mutation_needs_the_csrf_header(
    two_households: Pair, method: str, path: str
) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, _o2) = await _night(host, 2)
        await _phone_for(kid, a, code, sam)
        caller = kid if path.endswith("/ballots") else host
        resp = await _send(
            caller, method, BASE + path.format(sid=sid), _ballot(sam, o1), csrf=False
        )
    assert resp.status_code == 403
    assert "CSRF" in resp.json()["error"]["message"]
    assert await _ballot_rows(a, sid) == []
    assert (await _rows(a, "SELECT status FROM sessions WHERE id = :s", s=sid))[
        0
    ].status == "voting"


async def test_a_stored_ranking_stays_hidden_until_the_status_says_revealed(
    two_households: Pair,
) -> None:
    """The status, not the presence of a ranking, gates the result (e.g. a re-opened vote)."""
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _code, _opts = await _night(host, 2)
        assert (await _close_voting(host, sid)).status_code == 200
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE sessions SET status = 'voting' WHERE id = :s"), {"s": sid}
            )
        snap = (await host.client.get(f"{BASE}/{sid}")).json()
        listed = (await host.client.get(BASE, params={"status": "voting"})).json()
    assert snap["result"] is None
    assert [n["winner"] for n in listed if n["id"] == sid] == [None]
