"""Device authentication, the avatar grid and person binding (ADR-0002)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import DEVICE_COOKIE
from app.services import people_service
from tests.integration.phones import Phone, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "PPK234"


async def _add_person(household: SeededHousehold, name: str) -> uuid.UUID:
    async with household_session(household.household_id) as db:
        pid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, :n, '🐙', '#38bdf8') RETURNING id"
                ),
                {"h": household.household_id, "n": name},
            )
        ).scalar_one()
    return pid


async def _joined(p: Phone, household: SeededHousehold) -> str:
    resp = await p.join(household.slug, CODE)
    assert resp.status_code == 200, resp.text
    device_id: str = resp.json()["device_id"]
    return device_id


# --- ADR-0002: device authentication -----------------------------------------------


async def test_no_cookie_or_unknown_cookie_is_401(two_households: Pair) -> None:
    async with phone() as p:
        assert (await p.client.get("/api/v1/devices/me")).status_code == 401
        p.client.cookies.set(DEVICE_COOKIE, "forged-token", domain="fnh.test")
        assert (await p.client.get("/api/v1/people")).status_code == 401


async def test_revoked_device_gets_401(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        device_id = await _joined(p, a)
        assert (await p.client.get("/api/v1/devices/me")).status_code == 200
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE devices SET revoked_at = now() WHERE id = :d"), {"d": device_id}
            )
        assert (await p.client.get("/api/v1/devices/me")).status_code == 401
        assert (await p.bind(a.ids["person"])).status_code == 401


async def test_request_stamps_last_seen(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        device_id = await _joined(p, a)
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE devices SET last_seen_at = NULL WHERE id = :d"), {"d": device_id}
            )
        resp = await p.client.get("/api/v1/devices/me")
        assert any(c.startswith(DEVICE_COOKIE) for c in resp.headers.get_list("set-cookie"))
    async with household_session(a.household_id) as db:
        seen = await db.scalar(
            text("SELECT last_seen_at FROM devices WHERE id = :d"), {"d": device_id}
        )
    assert seen is not None


# --- Avatar grid ------------------------------------------------------------------


async def test_grid_shows_only_this_households_people(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        await _joined(p, a)
        people = (await p.client.get("/api/v1/people")).json()
    ids = {person["id"] for person in people}
    assert str(a.ids["person"]) in ids
    assert str(b.ids["person"]) not in ids


async def test_mutations_need_csrf(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        await _joined(p, a)
        resp = await p.client.put(f"/api/v1/devices/me/people/{a.ids['person']}")
        assert resp.status_code == 403


# --- Binding ----------------------------------------------------------------------


async def test_binding_a_free_person_is_active_and_idempotent(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    mia = await _add_person(a, "Mia")
    async with phone() as p:
        await _joined(p, a)
        first = await p.bind(mia)
        again = await p.bind(mia)
        assert first.json() == {"person_id": str(mia), "status": "active", "current": True}
        assert again.json()["status"] == "active"
        me = (await p.client.get("/api/v1/devices/me")).json()
        assert [(x["id"], x["binding"]) for x in me["people"]] == [(str(mia), "mine")]


async def test_shared_phone_can_hold_several_people(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    mia, leo = await _add_person(a, "Mia"), await _add_person(a, "Leo")
    async with phone() as p:
        await _joined(p, a)
        assert (await p.bind(mia)).json()["status"] == "active"
        assert (await p.bind(leo)).json()["status"] == "active"
        assert len((await p.client.get("/api/v1/devices/me")).json()["people"]) == 2


async def test_claiming_someone_bound_elsewhere_is_pending(two_households: Pair) -> None:
    """ADR-0002, kept by ADR-0014 as the admin override: a claim without the PIN on a person
    another device holds waits for a host."""
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    mia = await _add_person(a, "Mia")
    async with phone() as phone_a, phone() as phone_b:
        await _joined(phone_a, a)
        device_b = await _joined(phone_b, a)
        assert (await phone_a.bind(mia)).json()["status"] == "active"
        assert (await phone_b.bind(mia, pin=None)).json()["status"] == "pending"

        grid_b = {
            x["id"]: x["binding"] for x in (await phone_b.client.get("/api/v1/people")).json()
        }
        assert grid_b[str(mia)] == "pending"
    async with household_session(a.household_id) as db:
        assert not await people_service.can_act_as(db, uuid.UUID(device_b), mia)


async def test_device_cannot_act_as_a_person_bound_only_to_another_device(
    two_households: Pair,
) -> None:
    """ADR-0002 test: device A cannot vote as a person bound only to device B. Ballots will
    call require_can_act_as; this pins its behaviour before they exist."""
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    mia = await _add_person(a, "Mia")
    async with phone() as phone_a, phone() as phone_b:
        device_a = uuid.UUID(await _joined(phone_a, a))
        device_b = uuid.UUID(await _joined(phone_b, a))
        await phone_b.bind(mia)
    async with household_session(a.household_id) as db:
        assert await people_service.can_act_as(db, device_b, mia)
        assert not await people_service.can_act_as(db, device_a, mia)
        with pytest.raises(people_service.Forbidden):
            await people_service.require_can_act_as(db, device_a, mia)
        await people_service.require_can_act_as(db, device_b, mia)


async def test_revoked_device_frees_its_people(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    mia = await _add_person(a, "Mia")
    async with phone() as phone_a, phone() as phone_b:
        device_a = await _joined(phone_a, a)
        await _joined(phone_b, a)
        await phone_a.bind(mia)
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE devices SET revoked_at = now() WHERE id = :d"), {"d": device_a}
            )
        assert (await phone_b.bind(mia)).json()["status"] == "active"


async def test_cannot_bind_another_households_person(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as p:
        await _joined(p, a)
        assert (await p.bind(b.ids["person"])).status_code == 404
        assert (await p.bind(uuid.uuid4())).status_code == 404


async def test_unbind(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    mia = await _add_person(a, "Mia")
    async with phone() as p:
        await _joined(p, a)
        await p.bind(mia)
        assert (await p.unbind(mia)).status_code == 204
        assert (await p.unbind(mia)).status_code == 204  # idempotent
        assert (await p.client.get("/api/v1/devices/me")).json()["people"] == []
