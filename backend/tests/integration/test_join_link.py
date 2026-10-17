"""The TV's join QR (owner decision 2026-10-17): `settings.qr_includes_night_code` and
`GET /devices/me/join-link`. The night code itself is never stored or returned."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.core.database import household_session
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "QRCDEF"
SETTINGS = "/api/v1/admin/settings"
LINK = "/api/v1/devices/me/join-link"


async def _tv(p: Phone, h: SeededHousehold) -> None:
    resp = await p.join(h.slug, CODE)
    assert resp.status_code == 200, resp.text
    async with household_session(h.household_id) as db:
        await db.execute(
            text("UPDATE devices SET is_tv = true WHERE id = :d"),
            {"d": uuid.UUID(resp.json()["device_id"])},
        )


async def test_setting_defaults_off_and_admin_can_turn_it_on(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as p, phone() as other:
        p.sign_in_as(a.ids["account"], a.household_id)
        other.sign_in_as(b.ids["account"], b.household_id)
        initial = (await p.client.get(SETTINGS)).json()
        on = await p.patch(SETTINGS, {"qr_includes_night_code": True})
        unrelated = await p.patch(SETTINGS, {"region": "CA"})
        bad = await p.patch(SETTINGS, {"qr_includes_night_code": "sometimes"})
        theirs = (await other.client.get(SETTINGS)).json()
    assert initial["qr_includes_night_code"] is False
    assert on.json()["qr_includes_night_code"] is True
    assert unrelated.json()["qr_includes_night_code"] is True  # left out = unchanged
    assert bad.status_code == 422
    assert theirs["qr_includes_night_code"] is False
    async with household_session(a.household_id) as db:
        data = await db.scalar(
            text(
                "SELECT data FROM audit_events WHERE action = 'settings.updated' "
                "ORDER BY created_at LIMIT 1"
            )
        )
    assert data == {
        "from": {"qr_includes_night_code": False},
        "to": {"qr_includes_night_code": True},
    }


async def test_hosts_cannot_change_it(two_households: Pair) -> None:
    a, _ = two_households
    host_id = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@x.test")
    async with phone() as p:
        p.sign_in_as(host_id, a.household_id)
        resp = await p.patch(SETTINGS, {"qr_includes_night_code": True})
    assert resp.status_code == 403


async def test_the_tv_and_hosts_read_the_join_link(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    host_id = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@x.test")
    async with phone() as tv, phone() as host, phone() as kid, phone() as nobody:
        await _tv(tv, a)
        host.sign_in_as(host_id, a.household_id)
        assert (await kid.join(a.slug, CODE)).status_code == 200
        off = await tv.client.get(LINK)
        async with household_session(a.household_id) as db:
            await db.execute(text("UPDATE settings SET qr_includes_night_code = true"))
        on = await tv.client.get(LINK)
        by_host = await host.client.get(LINK)
        by_phone = await kid.client.get(LINK)
        anonymous = await nobody.client.get(LINK)
    assert off.json() == {"join_slug": a.slug, "qr_includes_night_code": False}
    assert on.json() == {"join_slug": a.slug, "qr_includes_night_code": True}
    assert by_host.json() == on.json()
    assert by_phone.status_code == 403
    assert anonymous.status_code == 401
    # Never the night code, and never another household's slug.
    assert CODE not in on.text and b.slug not in on.text
