"""Admin "Devices" list, labels and revocation (ADR-0002: revoked device gets 401)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.core.database import household_session
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "DVC234"
DEVICES = "/api/v1/admin/devices"


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _audit_actions(h: SeededHousehold, target: uuid.UUID) -> list[str]:
    async with household_session(h.household_id) as db:
        rows = await db.execute(
            text("SELECT action FROM audit_events WHERE target_id = :t ORDER BY created_at"),
            {"t": target},
        )
        return [r.action for r in rows]


async def test_admin_lists_devices_with_their_people(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as kid_phone, phone() as admin:
        joined = await kid_phone.join(a.slug, CODE, device_label="Mateo's iPad")
        new_id = joined.json()["device_id"]
        await kid_phone.bind(a.ids["person"])  # bound to the seeded device -> pending
        _as_admin(admin, a)
        resp = await admin.client.get(DEVICES)
        assert resp.status_code == 200
        listed = {d["id"]: d for d in resp.json()}
    assert set(listed) == {str(a.ids["device"]), new_id}  # never household b's
    assert str(b.ids["device"]) not in listed
    new = listed[new_id]
    assert new["label"] == "Mateo's iPad"
    assert new["is_tv"] is False and new["revoked_at"] is None
    assert new["last_seen_at"] is not None
    assert new["people"] == [
        {
            "person_id": str(a.ids["person"]),
            "name": "Kid",
            "avatar_emoji": "🦖",
            "status": "pending",
        }
    ]
    assert listed[str(a.ids["device"])]["people"][0]["status"] == "active"
    # Most recently seen first: the seeded device has never been seen.
    assert [d for d in listed][0] == new_id


async def test_devices_admin_needs_admin_devices(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{a.slug}@example.test")
    target = a.ids["device"]
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await p.client.get(DEVICES)).status_code == 403
        assert (await p.post(f"{DEVICES}/{target}/revoke")).status_code == 403
        assert (await p.patch(f"{DEVICES}/{target}", {"label": "x"})).status_code == 403
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as member:
        await member.join(a.slug, CODE)
        assert (await member.client.get(DEVICES)).status_code == 401
        assert (await member.post(f"{DEVICES}/{target}/revoke")).status_code == 401


async def test_label_set_and_cleared(two_households: Pair) -> None:
    a, _ = two_households
    target = a.ids["device"]
    async with phone() as p:
        _as_admin(p, a)
        resp = await p.patch(f"{DEVICES}/{target}", {"label": "  Kitchen   tablet "})
        assert resp.status_code == 200
        assert resp.json()["label"] == "Kitchen tablet"
        assert (await p.patch(f"{DEVICES}/{target}", {"label": None})).json()["label"] is None
        assert (await p.patch(f"{DEVICES}/{target}", {"label": "x" * 81})).status_code == 422
        await p.csrf()
        no_csrf = await p.client.patch(f"{DEVICES}/{target}", json={"label": "y"})
        assert no_csrf.status_code == 403
    assert await _audit_actions(a, target) == ["device.relabeled", "device.relabeled"]


async def test_other_household_devices_are_404(two_households: Pair) -> None:
    a, b = two_households
    theirs = b.ids["device"]
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.patch(f"{DEVICES}/{theirs}", {"label": "mine"})).status_code == 404
        assert (await p.post(f"{DEVICES}/{theirs}/revoke")).status_code == 404
        assert (await p.post(f"{DEVICES}/{uuid.uuid4()}/revoke")).status_code == 404
    async with household_session(b.household_id) as db:
        row = (
            await db.execute(
                text("SELECT label, revoked_at FROM devices WHERE id = :d"), {"d": theirs}
            )
        ).one()
    assert row.label is None and row.revoked_at is None


async def test_revoked_device_is_locked_out_and_its_people_become_claimable(
    two_households: Pair,
) -> None:
    a, _ = two_households
    kid = a.ids["person"]
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as lost, phone() as new_phone, phone() as admin:
        lost_id = (await lost.join(a.slug, CODE)).json()["device_id"]
        # Free the seeded device's hold on Kid so the lost phone gets an active binding.
        async with household_session(a.household_id) as db:
            await db.execute(text("DELETE FROM device_people WHERE person_id = :p"), {"p": kid})
        assert (await lost.bind(kid)).json()["status"] == "active"
        assert (await lost.client.get("/api/v1/devices/me")).status_code == 200

        await new_phone.join(a.slug, CODE)
        tiles = {
            t["id"]: t["binding"] for t in (await new_phone.client.get("/api/v1/people")).json()
        }
        assert tiles[str(kid)] == "taken"

        _as_admin(admin, a)
        resp = await admin.post(f"{DEVICES}/{lost_id}/revoke")
        assert resp.status_code == 200
        revoked_at = resp.json()["revoked_at"]
        assert revoked_at is not None

        # The cookie is dead on the very next request, for reads and writes.
        assert (await lost.client.get("/api/v1/devices/me")).status_code == 401
        assert (await lost.client.get("/api/v1/people")).status_code == 401
        assert (await lost.bind(kid)).status_code == 401

        # Kid is free again: the new phone claims them without host approval.
        tiles = {
            t["id"]: t["binding"] for t in (await new_phone.client.get("/api/v1/people")).json()
        }
        assert tiles[str(kid)] == "free"
        assert (await new_phone.bind(kid)).json()["status"] == "active"

        # Idempotent and final: a second revoke keeps the first timestamp, one audit row.
        again = await admin.post(f"{DEVICES}/{lost_id}/revoke")
        assert again.status_code == 200
        assert again.json()["revoked_at"] == revoked_at
        listed = (await admin.client.get(DEVICES)).json()
        assert listed[-1]["id"] == lost_id  # revoked devices sort last

        # Rejoining with the night code mints a *new* device; the old one stays revoked.
        rejoined = (await lost.join(a.slug, CODE)).json()["device_id"]
        assert rejoined != lost_id
    assert await _audit_actions(a, uuid.UUID(lost_id)) == ["device.revoked"]


async def test_revoking_a_device_drops_its_pending_claims_from_review(
    two_households: Pair,
) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as claimer, phone() as admin:
        claimer_id = (await claimer.join(a.slug, CODE)).json()["device_id"]
        assert (await claimer.bind(a.ids["person"])).json()["status"] == "pending"
        _as_admin(admin, a)
        assert len((await admin.client.get("/api/v1/devices/claims")).json()) == 1
        await admin.post(f"{DEVICES}/{claimer_id}/revoke")
        assert (await admin.client.get("/api/v1/devices/claims")).json() == []
