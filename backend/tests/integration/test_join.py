"""Night-code join, device cookie, CSRF and the join failure budget (ADR-0002)."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.security import DEVICE_COOKIE, hash_device_token
from tests.integration.phones import open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "FAM234"


async def _device_count(household: SeededHousehold) -> int:
    async with household_session(household.household_id) as db:
        count: int = await db.scalar(text("SELECT count(*) FROM devices"))
    return count


# --- Happy path -------------------------------------------------------------------


async def test_join_mints_a_hashed_device_token_in_a_hardened_cookie(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        resp = await p.join(a.slug, CODE, device_label="Kid's tablet")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["household_name"] == "Family a"
        assert body["session_id"] == str(a.ids["session"])

        cookie = next(c for c in resp.headers.get_list("set-cookie") if c.startswith(DEVICE_COOKIE))
        attrs = cookie.lower()
        assert "httponly" in attrs and "secure" in attrs and "samesite=lax" in attrs
        assert f"max-age={365 * 86400}" in attrs

        token = p.client.cookies[DEVICE_COOKIE]
        assert len(token) >= 43  # 256 bits
    async with household_session(a.household_id) as db:
        stored = (
            await db.execute(
                text("SELECT token_hash, label FROM devices WHERE id = :d"),
                {"d": body["device_id"]},
            )
        ).one()
    assert stored.token_hash == hash_device_token(token)
    assert token not in stored.token_hash
    assert stored.label == "Kid's tablet"


@pytest.mark.parametrize("typed", ["fam234", " FAM-234 ", "fam 234"])
async def test_code_is_forgiving_about_case_and_separators(
    two_households: Pair, typed: str
) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        assert (await p.join(a.slug, typed)).status_code == 200


@pytest.mark.parametrize("night_status", ["draft", "voting", "revealed", "tonight"])
async def test_code_works_for_every_live_status(two_households: Pair, night_status: str) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE, status=night_status)
    async with phone() as p:
        assert (await p.join(a.slug, CODE)).status_code == 200


async def test_rejoining_reuses_the_device(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    before = await _device_count(a)
    async with phone() as p:
        first = await p.join(a.slug, CODE)
        second = await p.join(a.slug, CODE)
        assert first.json()["device_id"] == second.json()["device_id"]
        assert not any(c.startswith(DEVICE_COOKIE) for c in second.headers.get_list("set-cookie"))
    assert await _device_count(a) == before + 1


async def test_cookie_from_another_household_gets_a_new_device(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    await open_night(b.household_id, b.ids["session"], "BBB234")
    async with phone() as p:
        in_a = await p.join(a.slug, CODE)
        token_a = p.client.cookies[DEVICE_COOKIE]
        in_b = await p.join(b.slug, "BBB234")
        assert in_b.status_code == 200
        assert in_b.json()["device_id"] != in_a.json()["device_id"]
        assert p.client.cookies[DEVICE_COOKIE] != token_a


# --- ADR-0002: no key, no entry --------------------------------------------------


@pytest.mark.parametrize(
    "case",
    ["wrong_code", "malformed_code", "unknown_slug", "closed_night", "other_households_code"],
)
async def test_cannot_join_without_a_live_code_for_this_household(
    two_households: Pair, case: str
) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    await open_night(b.household_id, b.ids["session"], "BBB234")
    slug, code = {
        "wrong_code": (a.slug, "ZZZ999"),
        "malformed_code": (a.slug, "!!"),
        "unknown_slug": ("no-such-family", CODE),
        "other_households_code": (a.slug, "BBB234"),
        "closed_night": (a.slug, CODE),
    }[case]
    if case == "closed_night":
        await open_night(a.household_id, a.ids["session"], CODE, status="closed")
    before = await _device_count(a)
    async with phone() as p:
        resp = await p.join(slug, code)
    assert resp.status_code == 400
    # One answer for every failure: no oracle for which slugs exist.
    assert resp.json()["error"]["message"] == "That code doesn't match tonight's night."
    assert DEVICE_COOKIE not in resp.headers.get("set-cookie", "")
    assert await _device_count(a) == before


async def test_join_without_a_code_is_rejected(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        resp = await p.client.post(
            "/api/v1/join",
            json={"slug": a.slug},
            headers={"X-FNH-CSRF": await p.csrf()},
        )
    assert resp.status_code == 422


# --- CSRF ----------------------------------------------------------------------


@pytest.mark.parametrize("header", [None, "not-the-cookie"])
async def test_join_requires_matching_csrf_header(two_households: Pair, header: str | None) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        await p.csrf()  # cookie present
        headers = {"X-FNH-CSRF": header} if header else {}
        resp = await p.client.post(
            "/api/v1/join", json={"slug": a.slug, "night_code": CODE}, headers=headers
        )
    assert resp.status_code == 403


async def test_csrf_cookie_is_readable_and_stable() -> None:
    async with phone() as p:
        first = await p.client.get("/api/v1/csrf")
        cookie = first.headers["set-cookie"].lower()
        assert "httponly" not in cookie and "secure" in cookie and "samesite=lax" in cookie
        second = await p.client.get("/api/v1/csrf")
        assert first.json()["csrf_token"] == second.json()["csrf_token"]


# --- Failure budget ---------------------------------------------------------------


async def test_failures_exhaust_the_slug_budget_then_even_the_right_code_waits(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, b = two_households
    monkeypatch.setattr(settings, "JOIN_FAILURE_LIMIT", 3)
    await open_night(a.household_id, a.ids["session"], CODE)
    await open_night(b.household_id, b.ids["session"], "BBB234")
    async with phone() as p:
        for _ in range(3):
            assert (await p.join(a.slug, "ZZZ999")).status_code == 400
        limited = await p.join(a.slug, CODE)
        assert limited.status_code == 429
        assert 1 <= int(limited.headers["retry-after"]) <= settings.JOIN_FAILURE_WINDOW_SECONDS
        # Another household's door is unaffected.
        assert (await p.join(b.slug, "BBB234")).status_code == 200


async def test_successful_joins_do_not_spend_the_budget(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "JOIN_FAILURE_LIMIT", 2)
    await open_night(a.household_id, a.ids["session"], CODE)
    for _ in range(4):  # a family of four, one shared Wi-Fi address
        async with phone() as p:
            assert (await p.join(a.slug, CODE)).status_code == 200
