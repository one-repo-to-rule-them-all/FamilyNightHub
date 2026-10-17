"""Host enrollment, TV pairing and claim review (ADR-0002)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import ACCOUNT_COOKIE, DEVICE_COOKIE
from app.services import people_service
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "DEV234"


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _device_row(h: SeededHousehold, device_id: str) -> tuple[bool, str | None]:
    async with household_session(h.household_id) as db:
        row = (
            await db.execute(
                text("SELECT is_tv, label FROM devices WHERE id = :d"), {"d": device_id}
            )
        ).one()
    return row.is_tv, row.label


# --- Enrollment -------------------------------------------------------------------


async def test_host_lets_a_phone_in_without_the_code(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{a.slug}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        resp = await p.post("/api/v1/devices/enroll", {"device_label": "Grandma's phone"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_tv"] is False
        assert DEVICE_COOKIE in p.client.cookies
        # The phone now works as a device, and the host stays signed in.
        assert (await p.client.get("/api/v1/devices/me")).status_code == 200
        assert (await p.client.get("/api/v1/auth/me")).status_code == 200
    assert await _device_row(a, resp.json()["device_id"]) == (False, "Grandma's phone")


async def test_pairing_the_tv_signs_the_host_out_of_that_browser(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as tv:
        _as_admin(tv, a)
        body = {"device_label": "Living room", "as_tv": True}
        resp = await tv.post("/api/v1/devices/enroll", body)
        assert resp.status_code == 200
        assert resp.json()["is_tv"] is True
        cleared = [c for c in resp.headers.get_list("set-cookie") if c.startswith(ACCOUNT_COOKIE)]
        assert cleared and "max-age=0" in cleared[0].lower()
        assert (await tv.client.get("/api/v1/auth/me")).status_code == 401
        assert (await tv.client.get("/api/v1/devices/me")).status_code == 200
    assert await _device_row(a, resp.json()["device_id"]) == (True, "Living room")


async def test_enrolling_a_browser_that_already_has_a_device_reuses_it(
    two_households: Pair,
) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        joined = (await p.join(a.slug, CODE)).json()["device_id"]
        _as_admin(p, a)
        resp = await p.post("/api/v1/devices/enroll", {"as_tv": True})
        assert resp.json()["device_id"] == joined
        assert not any(c.startswith(DEVICE_COOKIE) for c in resp.headers.get_list("set-cookie"))
    assert (await _device_row(a, joined))[0] is True


async def test_device_from_another_household_is_not_reused(two_households: Pair) -> None:
    a, b = two_households
    await open_night(b.household_id, b.ids["session"], CODE)
    async with phone() as p:
        from_b = (await p.join(b.slug, CODE)).json()["device_id"]
        _as_admin(p, a)
        resp = await p.post("/api/v1/devices/enroll", {})
        assert resp.json()["device_id"] != from_b


async def test_enroll_needs_a_signed_in_account_and_csrf(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        await p.join(a.slug, CODE)  # a member device, no account
        assert (await p.post("/api/v1/devices/enroll", {})).status_code == 401
        _as_admin(p, a)
        no_csrf = await p.client.post("/api/v1/devices/enroll", json={})
        assert no_csrf.status_code == 403


# --- Claims -----------------------------------------------------------------------


async def _pending_claim(a: SeededHousehold) -> tuple[uuid.UUID, uuid.UUID]:
    """Phone 1 holds a fresh kid; phone 2 claims them -> pending. Returns (device2, kid).
    (Not the seeded person: the seed already binds them to its own device.)"""
    await open_night(a.household_id, a.ids["session"], CODE)
    async with household_session(a.household_id) as db:
        kid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, 'Kid', 'fox', '#f97316') RETURNING id"
                ),
                {"h": a.household_id},
            )
        ).scalar_one()
    async with phone() as p1, phone() as p2:
        await p1.join(a.slug, CODE)
        assert (await p1.bind(kid)).json()["status"] == "active"
        device2 = uuid.UUID((await p2.join(a.slug, CODE)).json()["device_id"])
        assert (await p2.bind(kid, pin=None)).json()["status"] == "pending"
    return device2, kid


async def test_host_sees_and_approves_a_pending_claim(two_households: Pair) -> None:
    a, b = two_households
    device2, kid = await _pending_claim(a)
    await _pending_claim(b)  # must not show up for household a
    async with phone() as host:
        _as_admin(host, a)
        claims = (await host.client.get("/api/v1/devices/claims")).json()
        assert [(c["device_id"], c["person_id"]) for c in claims] == [(str(device2), str(kid))]
        approve = f"/api/v1/devices/{device2}/people/{kid}/approve"
        assert (await host.post(approve)).status_code == 204
        assert (await host.client.get("/api/v1/devices/claims")).json() == []
        assert (await host.post(approve)).status_code == 404
    async with household_session(a.household_id) as db:
        assert await people_service.can_act_as(db, device2, kid)


async def test_host_rejects_a_pending_claim(two_households: Pair) -> None:
    a, _ = two_households
    device2, kid = await _pending_claim(a)
    async with phone() as host:
        _as_admin(host, a)
        reject = f"/api/v1/devices/{device2}/people/{kid}/reject"
        assert (await host.post(reject)).status_code == 204
        assert (await host.post(reject)).status_code == 404
    async with household_session(a.household_id) as db:
        assert not await people_service.can_act_as(db, device2, kid)


async def test_hosts_can_review_claims_too(two_households: Pair) -> None:
    a, _ = two_households
    device2, kid = await _pending_claim(a)
    host = await add_account(a.household_id, "host", f"host2.{a.slug}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        approve = f"/api/v1/devices/{device2}/people/{kid}/approve"
        assert (await p.post(approve)).status_code == 204


async def test_cannot_review_another_households_claims(two_households: Pair) -> None:
    a, b = two_households
    device_b, kid_b = await _pending_claim(b)
    async with phone() as host_a:
        _as_admin(host_a, a)
        resp = await host_a.post(f"/api/v1/devices/{device_b}/people/{kid_b}/approve")
        assert resp.status_code == 404
    async with household_session(b.household_id) as db:
        assert not await people_service.can_act_as(db, device_b, kid_b)


async def test_members_cannot_review_claims(two_households: Pair) -> None:
    a, _ = two_households
    device2, kid = await _pending_claim(a)
    async with phone() as member:
        await member.join(a.slug, CODE)
        assert (await member.client.get("/api/v1/devices/claims")).status_code == 401
        resp = await member.post(f"/api/v1/devices/{device2}/people/{kid}/approve")
        assert resp.status_code == 401
