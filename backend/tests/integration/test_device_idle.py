"""Device idle timeout (issue #56, ADR-0002 amendment): 30 days unused -> 401 `device_expired`."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.security import DEVICE_COOKIE
from tests.integration.phones import Phone, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "NAP234"
VISITOR = {"name": "Visitor", "avatar_emoji": "🦊", "color": "#f59e0b", "pin": "135790"}


async def _last_seen_days_ago(h: SeededHousehold, device_id: str | uuid.UUID, days: int) -> None:
    async with household_session(h.household_id) as db:
        await db.execute(
            text(
                "UPDATE devices SET last_seen_at = now() - make_interval(days => :n), "
                "created_at = now() - make_interval(days => :n) WHERE id = :d"
            ),
            {"n": days, "d": device_id},
        )


async def _joined(p: Phone, h: SeededHousehold) -> str:
    resp = await p.join(h.slug, CODE)
    assert resp.status_code == 200, resp.text
    device_id: str = resp.json()["device_id"]
    return device_id


async def _bindings(h: SeededHousehold, device_id: str) -> int:
    async with household_session(h.household_id) as db:
        count: int = await db.scalar(
            text("SELECT count(*) FROM device_people WHERE device_id = :d"), {"d": device_id}
        )
    return count


def test_window_is_thirty_days_and_touch_stays_well_inside_it() -> None:
    assert settings.DEVICE_IDLE_DAYS == 30
    assert settings.DEVICE_TOUCH_INTERVAL_SECONDS < settings.DEVICE_IDLE_DAYS * 86400 / 100


async def test_cookie_max_age_matches_the_idle_window(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        resp = await p.join(a.slug, CODE)
        cookie = next(c for c in resp.headers.get_list("set-cookie") if c.startswith(DEVICE_COOKIE))
    assert f"max-age={30 * 86400}" in cookie.lower()


async def test_a_phone_used_29_days_ago_still_works_and_slides(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        device_id = await _joined(p, a)
        await _last_seen_days_ago(a, device_id, 29)
        resp = await p.client.get("/api/v1/devices/me")
        assert resp.status_code == 200, resp.text
        # The stale stamp is refreshed and the cookie re-issued (sliding window).
        assert any(c.startswith(DEVICE_COOKIE) for c in resp.headers.get_list("set-cookie"))
    async with household_session(a.household_id) as db:
        fresh = await db.scalar(
            text("SELECT last_seen_at > now() - interval '1 minute' FROM devices WHERE id = :d"),
            {"d": device_id},
        )
    assert fresh is True


async def test_a_phone_unused_31_days_gets_device_expired(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        device_id = await _joined(p, a)
        await _last_seen_days_ago(a, device_id, 31)
        for path in (
            "/api/v1/devices/me",
            "/api/v1/people",
            f"/api/v1/sessions/{a.ids['session']}",
        ):
            resp = await p.client.get(path)
            assert resp.status_code == 401, path
            assert resp.json()["error"]["code"] == "device_expired", path
    # Not revoked, and not silently revived by the failed requests.
    async with household_session(a.household_id) as db:
        row = (
            await db.execute(
                text(
                    "SELECT revoked_at, last_seen_at < now() - interval '30 days' AS stale "
                    "FROM devices WHERE id = :d"
                ),
                {"d": device_id},
            )
        ).one()
    assert row.revoked_at is None and row.stale is True


async def test_unknown_and_revoked_tokens_keep_the_generic_401(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        p.client.cookies.set(DEVICE_COOKIE, "not-a-token", domain="fnh.test")
        resp = await p.client.get("/api/v1/devices/me")
        assert resp.status_code == 401 and resp.json()["error"]["code"] == "http_error"
    async with phone() as p:
        device_id = await _joined(p, a)
        await _last_seen_days_ago(a, device_id, 31)
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE devices SET revoked_at = now() WHERE id = :d"), {"d": device_id}
            )
        resp = await p.client.get("/api/v1/devices/me")
        assert resp.status_code == 401 and resp.json()["error"]["code"] == "http_error"


async def test_rejoining_with_the_code_revives_the_same_device_without_its_people(
    two_households: Pair,
) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        device_id = await _joined(p, a)
        created = await p.post("/api/v1/devices/me/people", VISITOR)
        assert created.status_code == 201, created.text
        assert await _bindings(a, device_id) == 1
        await _last_seen_days_ago(a, device_id, 31)
        assert (await p.client.get("/api/v1/people")).status_code == 401

        rejoined = await p.join(a.slug, CODE)
        assert rejoined.status_code == 200, rejoined.text
        assert rejoined.json()["device_id"] == device_id  # same row, same cookie
        assert (await p.client.get("/api/v1/devices/me")).status_code == 200
        # Bindings did not carry over: the phone picks its people again, with PINs.
        assert await _bindings(a, device_id) == 0
    async with household_session(a.household_id) as db:
        actions = (
            await db.scalars(
                text("SELECT action FROM audit_events WHERE actor_device_id = :d"),
                {"d": device_id},
            )
        ).all()
    assert "device.rejoined" in actions


async def test_rejoining_a_live_phone_keeps_its_people(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        device_id = await _joined(p, a)
        await p.post("/api/v1/devices/me/people", VISITOR)
        await _last_seen_days_ago(a, device_id, 29)
        assert (await p.join(a.slug, CODE)).status_code == 200
    assert await _bindings(a, device_id) == 1


async def test_tv_follows_the_same_rule_and_a_host_pairs_it_again(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as tv:
        tv.sign_in_as(a.ids["account"], a.household_id)
        paired = await tv.post("/api/v1/devices/enroll", {"device_label": "Den", "as_tv": True})
        tv_id = paired.json()["device_id"]
        await _last_seen_days_ago(a, tv_id, 29)
        assert (await tv.client.get("/api/v1/devices/me/join-link")).status_code == 200

        await _last_seen_days_ago(a, tv_id, 31)
        resp = await tv.client.get("/api/v1/devices/me/join-link")
        assert resp.status_code == 401 and resp.json()["error"]["code"] == "device_expired"

        # The night code alone revives it as an ordinary phone, not as the TV.
        await open_night(a.household_id, a.ids["session"], CODE)
        assert (await tv.join(a.slug, CODE)).json()["device_id"] == tv_id
        assert (await tv.client.get("/api/v1/devices/me/join-link")).status_code == 403

        # A host choosing "Use this browser as the TV" again restores it.
        await _last_seen_days_ago(a, tv_id, 31)
        tv.sign_in_as(a.ids["account"], a.household_id)
        again = await tv.post("/api/v1/devices/enroll", {"as_tv": True})
        assert again.json() == {"device_id": tv_id, "is_tv": True}
        assert (await tv.client.get("/api/v1/devices/me/join-link")).status_code == 200


async def test_admin_list_shows_expired_devices(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as old, phone() as fresh, phone() as admin:
        old_id = await _joined(old, a)
        fresh_id = await _joined(fresh, a)
        await _last_seen_days_ago(a, old_id, 31)
        admin.sign_in_as(a.ids["account"], a.household_id)
        listed = {d["id"]: d for d in (await admin.client.get("/api/v1/admin/devices")).json()}
        assert listed[old_id]["expired"] is True and listed[old_id]["revoked_at"] is None
        assert listed[fresh_id]["expired"] is False
        # Revoked wins over expired: it is final, not "come back with the code".
        await admin.post(f"/api/v1/admin/devices/{old_id}/revoke")
        listed = {d["id"]: d for d in (await admin.client.get("/api/v1/admin/devices")).json()}
        assert listed[old_id]["expired"] is False and listed[old_id]["revoked_at"] is not None
