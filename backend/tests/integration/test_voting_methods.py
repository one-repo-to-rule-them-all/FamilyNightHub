"""Approval and pick-one nights end to end through the API (ADR-0010): choosing the method,
the draft-only lock, per-method ballot rules, proxy ballots and the seeded tie-break."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import Response

from app.core.config import settings
from app.domain.voting import approval, pick_one
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_voting import (
    BASE,
    _actions,
    _ballot_rows,
    _close_voting,
    _host,
    _person,
    _phone_for,
    _proxy,
    _send,
    _vote,
)

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
SETTINGS = "/api/v1/admin/settings"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    yield


async def _night(
    host: Phone, n: int, method: str | None, *, open_voting: bool = True
) -> tuple[str, str, list[str]]:
    """A night of n typed titles with `method` (None = household default)."""
    body: dict[str, Any] = {"title": "Friday"}
    if method is not None:
        body["voting_method"] = method
    resp = await host.post(BASE, body)
    assert resp.status_code == 201, resp.text
    created = resp.json()
    sid = created["session_id"]
    for i in range(n):
        added = await host.post(f"{BASE}/{sid}/options", {"title": f"T {uuid.uuid4().hex[:6]} {i}"})
        assert added.status_code == 201, added.text
    if open_voting:
        assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
    snap = (await host.client.get(f"{BASE}/{sid}")).json()
    return sid, created["night_code"], [o["id"] for o in snap["options"]]


async def _snap(p: Phone, sid: str) -> dict[str, Any]:
    resp = await p.client.get(f"{BASE}/{sid}")
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def _ranks(p: Phone, sid: str, person: uuid.UUID, ranks: list[tuple[str, int]]) -> Response:
    body = {"person_id": str(person), "ranks": [{"option_id": o, "rank": r} for o, r in ranks]}
    return await _send(p, "PUT", f"{BASE}/{sid}/ballots", body)


# --- Choosing the method ---------------------------------------------------------------


@pytest.mark.parametrize("method", ["top3", "approval", "pick_one"])
async def test_the_method_is_chosen_at_creation(two_households: Pair, method: str) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        sid, _code, opts = await _night(host, 4, method, open_voting=False)
        draft = await _snap(host, sid)
        assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
        opened = await _snap(host, sid)
    assert (draft["voting_method"], draft["ballot_size"]) == (method, None)
    expected_k = {"top3": 3, "approval": len(opts), "pick_one": 1}[method]
    assert (opened["voting_method"], opened["ballot_size"]) == (method, expected_k)


async def test_a_new_night_takes_the_household_default(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as admin:
        account = await add_account(a.household_id, "admin", f"a.{uuid.uuid4().hex[:10]}@ex.test")
        admin.sign_in_as(account, a.household_id)
        before, _c, _o = await _night(admin, 0, None, open_voting=False)
        resp = await admin.patch(SETTINGS, {"default_voting_method": "pick_one"})
        assert resp.status_code == 200, resp.text
        after, _c, _o = await _night(admin, 0, None, open_voting=False)
        explicit, _c, _o = await _night(admin, 0, "approval", open_voting=False)
        methods = [(await _snap(admin, s))["voting_method"] for s in (before, after, explicit)]
    assert methods == ["top3", "pick_one", "approval"]


async def test_an_unknown_method_is_422(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        created = await host.post(BASE, {"voting_method": "borda"})
        sid, _c, _o = await _night(host, 2, "top3", open_voting=False)
        patched = await host.patch(f"{BASE}/{sid}", {"voting_method": "borda"})
    assert (created.status_code, patched.status_code) == (422, 422)


async def test_the_method_changes_only_while_draft(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as host, phone() as other:
        await _host(host, a)
        await _host(other, b)
        sid, _code, _opts = await _night(host, 3, "top3", open_voting=False)
        changed = await host.patch(f"{BASE}/{sid}", {"voting_method": "approval"})
        same = await host.patch(f"{BASE}/{sid}", {"voting_method": "approval"})
        foreign = await other.patch(f"{BASE}/{sid}", {"voting_method": "pick_one"})
        no_csrf = await host.client.patch(f"{BASE}/{sid}", json={"voting_method": "pick_one"})
        assert (await host.post(f"{BASE}/{sid}/open-voting")).status_code == 200
        locked = await host.patch(f"{BASE}/{sid}", {"voting_method": "pick_one"})
        snap = await _snap(host, sid)
    assert changed.status_code == 200 and changed.json()["voting_method"] == "approval"
    assert same.status_code == 200
    assert foreign.status_code == 404
    assert no_csrf.status_code == 403
    assert locked.status_code == 409 and "locked" in locked.json()["error"]["message"]
    assert (snap["voting_method"], snap["ballot_size"]) == ("approval", 3)
    # One audit row for the real change; the no-op repeat writes nothing.
    assert (await _actions(a, sid)).count("session.voting_method_changed") == 1


async def test_a_phone_cannot_change_the_method(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, _opts = await _night(host, 2, "top3", open_voting=False)
        await _phone_for(kid, a, code, sam)
        resp = await kid.patch(f"{BASE}/{sid}", {"voting_method": "pick_one"})
    assert resp.status_code == 401


# --- pick_one --------------------------------------------------------------------------


async def test_pick_one_takes_exactly_one_option(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, o2, o3) = await _night(host, 3, "pick_one")
        await _phone_for(kid, a, code, sam)
        two = await _vote(kid, sid, sam, o1, o2)
        rank_two = await _ranks(kid, sid, sam, [(o2, 2)])
        empty = await _ranks(kid, sid, sam, [])
        ok = await _vote(kid, sid, sam, o3)
        mine = (await kid.client.get(f"{BASE}/{sid}/ballots/mine")).json()
    assert (two.status_code, rank_two.status_code, empty.status_code) == (422, 422, 422)
    assert "exactly one" in two.json()["error"]["message"]
    assert ok.status_code == 204, ok.text
    assert mine == [{"person_id": str(sam), "ranks": [{"option_id": o3, "rank": 1}]}]


async def test_a_pick_one_tie_is_settled_by_the_seed_alone(two_households: Pair) -> None:
    a, _ = two_households
    people = [await _person(a, f"P{i}") for i in range(4)]
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, o2, o3) = await _night(host, 3, "pick_one")
        for person, choice in zip(people, (o1, o2, o1, o2), strict=True):
            assert (await _proxy(host, sid, person, choice)).status_code == 204
        resp = await _close_voting(host, sid, seed=20261015)
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    expected = pick_one.tally(
        [o1, o2, o3], [{o1: 1}, {o2: 1}, {o1: 1}, {o2: 1}], seed=20261015
    ).winner
    assert result["winner_option_id"] == expected
    assert (result["tiebreak"], sorted(result["tie_group"])) == ("random", sorted([o1, o2]))
    assert [(p["score"], p["first_places"]) for p in result["placements"]] == [
        (2, 2),
        (2, 2),
        (0, 0),
    ]
    assert result["placements"][2]["option_id"] == o3


async def test_pick_one_with_a_clear_winner(two_households: Pair) -> None:
    a, _ = two_households
    p1, p2, p3 = await _person(a, "P1"), await _person(a, "P2"), await _person(a, "P3")
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, o2) = await _night(host, 2, "pick_one")
        for person, choice in ((p1, o2), (p2, o2), (p3, o1)):
            assert (await _proxy(host, sid, person, choice)).status_code == 204
        result = (await _close_voting(host, sid)).json()["result"]
    assert (result["winner_option_id"], result["tiebreak"]) == (o2, "none")
    assert result["ballot_count"] == 3


# --- approval --------------------------------------------------------------------------


async def test_approval_takes_any_number_of_options(two_households: Pair) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, opts = await _night(host, 4, "approval")
        await _phone_for(kid, a, code, sam)
        everything = await _vote(kid, sid, sam, *opts)
        rows_all = await _ballot_rows(a, sid)
        two = await _vote(kid, sid, sam, opts[3], opts[0])
    assert everything.status_code == 204, everything.text
    assert [r.rank for r in rows_all] == [1, 2, 3, 4]
    assert two.status_code == 204
    rows = await _ballot_rows(a, sid)
    assert [(str(r.option_id), r.rank) for r in rows] == [(opts[3], 1), (opts[0], 2)]


@pytest.mark.parametrize("case", ["empty", "twice", "gap", "foreign", "too_many"])
async def test_bad_approval_ballots_are_422(two_households: Pair, case: str) -> None:
    a, _ = two_households
    sam = await _person(a)
    async with phone() as host, phone() as kid:
        await _host(host, a)
        sid, code, (o1, o2, o3) = await _night(host, 3, "approval")
        _, _, (foreign, _x) = await _night(host, 2, "approval")
        await _phone_for(kid, a, code, sam)
        ranks = {
            "empty": [],
            "twice": [(o1, 1), (o1, 2)],
            "gap": [(o1, 1), (o2, 3)],
            "foreign": [(foreign, 1)],
            "too_many": [(o1, 1), (o2, 2), (o3, 3), (o1, 4)],
        }[case]
        resp = await _ranks(kid, sid, sam, ranks)
    assert resp.status_code == 422, resp.text
    assert await _ballot_rows(a, sid) == []


async def test_a_host_proxy_approves_for_a_kid(two_households: Pair) -> None:
    a, _ = two_households
    toddler = await _person(a, "Toddler", "🐣")
    async with phone() as host:
        account = await _host(host, a)
        sid, _code, (o1, o2, o3, o4, o5) = await _night(host, 5, "approval")
        assert (await _proxy(host, sid, toddler, o5, o1, o3, o2)).status_code == 204
    rows = await _ballot_rows(a, sid)
    assert [(str(r.option_id), r.rank, r.is_proxy, r.cast_by_account_id) for r in rows] == [
        (o5, 1, True, account),
        (o1, 2, True, account),
        (o3, 3, True, account),
        (o2, 4, True, account),
    ]
    assert o4 not in {str(r.option_id) for r in rows}


async def test_sole_approvals_break_an_approval_tie(two_households: Pair) -> None:
    a, _ = two_households
    p1, p2, p3 = await _person(a, "P1"), await _person(a, "P2"), await _person(a, "P3")
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, o2, o3) = await _night(host, 3, "approval")
        # o1 and o2: two approvals each; only o2 has a sole approval (P3).
        assert (await _proxy(host, sid, p1, o1, o2)).status_code == 204
        assert (await _proxy(host, sid, p2, o1, o3)).status_code == 204
        assert (await _proxy(host, sid, p3, o2)).status_code == 204
        resp = await _close_voting(host, sid, seed=1)
    result = resp.json()["result"]
    assert result["winner_option_id"] == o2
    assert (result["tiebreak"], result["tie_group"]) == ("first_places", [o2, o1])
    assert [(p["option_id"], p["score"], p["first_places"]) for p in result["placements"]] == [
        (o2, 2, 1),
        (o1, 2, 0),
        (o3, 1, 0),
    ]
    assert resp.json()["voting_method"] == "approval"


async def test_a_level_approval_tie_is_settled_by_the_seed(two_households: Pair) -> None:
    a, _ = two_households
    p1, p2 = await _person(a, "P1"), await _person(a, "P2")
    async with phone() as host:
        await _host(host, a)
        sid, _code, (o1, o2, o3) = await _night(host, 3, "approval")
        assert (await _proxy(host, sid, p1, o1, o2)).status_code == 204
        assert (await _proxy(host, sid, p2, o2, o1)).status_code == 204
        first = (await _close_voting(host, sid, seed=4242)).json()["result"]
        again = (await _close_voting(host, sid, seed=7)).json()["result"]  # idempotent
    expected = approval.tally([o1, o2, o3], [{o1: 1, o2: 2}, {o2: 1, o1: 2}], seed=4242)
    assert first["winner_option_id"] == expected.winner
    assert first["tiebreak"] == "random" and sorted(first["tie_group"]) == sorted([o1, o2])
    assert again == first and first["tie_seed"] == "4242"
