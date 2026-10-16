"""ADR-0009 pre-auth resolver functions, called as fnh_app with no household GUC."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.database import AsyncSessionLocal, household_session
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]


async def _call(sql: str, **params: object) -> list[dict[str, object]]:
    async with AsyncSessionLocal() as s, s.begin():
        result = await s.execute(text(sql), params)
        return [dict(r._mapping) for r in result]


async def test_resolve_device_returns_ids_only(two_households: Pair) -> None:
    a, _ = two_households
    rows = await _call("SELECT * FROM auth_resolve_device(:t)", t=a.device_token_hash)
    assert rows == [{"device_id": a.ids["device"], "household_id": a.household_id}]


async def test_resolve_device_ignores_unknown_and_revoked(two_households: Pair) -> None:
    a, _ = two_households
    assert await _call("SELECT * FROM auth_resolve_device(:t)", t="nope") == []
    async with household_session(a.household_id) as s:
        await s.execute(
            text("UPDATE devices SET revoked_at = now() WHERE id = :d"), {"d": a.ids["device"]}
        )
    assert await _call("SELECT * FROM auth_resolve_device(:t)", t=a.device_token_hash) == []


async def test_resolve_magic_link_only_while_live(two_households: Pair) -> None:
    a, b = two_households
    expected = {
        "magic_link_id": a.ids["magic_link"],
        "account_id": a.ids["account"],
        "household_id": a.household_id,
    }
    sql = "SELECT * FROM auth_resolve_magic_link(:t)"
    assert await _call(sql, t=a.magic_link_token_hash) == [expected]

    async with household_session(a.household_id) as s:
        await s.execute(
            text("UPDATE magic_links SET used_at = now() WHERE id = :m"), {"m": a.ids["magic_link"]}
        )
    assert await _call(sql, t=a.magic_link_token_hash) == []

    async with household_session(b.household_id) as s:
        await s.execute(
            text("UPDATE magic_links SET expires_at = now() - interval '1 second' WHERE id = :m"),
            {"m": b.ids["magic_link"]},
        )
    assert await _call(sql, t=b.magic_link_token_hash) == []


async def test_resolve_magic_link_ignores_disabled_account(two_households: Pair) -> None:
    a, _ = two_households
    async with household_session(a.household_id) as s:
        await s.execute(
            text("UPDATE accounts SET disabled_at = now() WHERE id = :a"), {"a": a.ids["account"]}
        )
    assert await _call("SELECT * FROM auth_resolve_magic_link(:t)", t=a.magic_link_token_hash) == []


async def test_resolve_account_by_email_is_case_insensitive(two_households: Pair) -> None:
    a, _ = two_households
    rows = await _call("SELECT * FROM auth_resolve_account_by_email(:e)", e=a.account_email.upper())
    assert rows == [{"account_id": a.ids["account"], "household_id": a.household_id}]


async def test_resolve_household_by_slug(two_households: Pair) -> None:
    a, _ = two_households
    rows = await _call("SELECT auth_resolve_household_by_slug(:s) AS id", s=a.slug)
    assert rows == [{"id": a.household_id}]
    rows = await _call("SELECT auth_resolve_household_by_slug(:s) AS id", s="missing")
    assert rows == [{"id": None}]


async def test_worker_lists_every_household(two_households: Pair) -> None:
    a, b = two_households
    rows = await _call("SELECT worker_list_household_ids() AS id")
    assert {a.household_id, b.household_id} <= {r["id"] for r in rows}


async def test_resolution_does_not_open_the_tables(two_households: Pair) -> None:
    """Calling a resolver must not leave fnh_app able to read the underlying rows."""
    a, _ = two_households
    async with AsyncSessionLocal() as s, s.begin():
        await s.execute(text("SELECT * FROM auth_resolve_device(:t)"), {"t": a.device_token_hash})
        assert await s.scalar(text("SELECT count(*) FROM devices")) == 0


async def test_app_role_cannot_become_resolver() -> None:
    with pytest.raises(DBAPIError, match="permission denied"):
        await _call("SET ROLE fnh_resolver")
