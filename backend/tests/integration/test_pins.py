"""Per-person PINs (ADR-0014): first claim, claim/switch with the PIN, wrong-PIN counting,
lock at 5, admin-approved resets, rename once, self-created guests, cross-household 404."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.security import CSRF_HEADER
from tests.integration.phones import TEST_PIN, Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "PQRSTU"
ME = "/api/v1/devices/me/people"
RESETS = "/api/v1/admin/people/pin-resets"
WRONG = "135791"


async def _person(h: SeededHousehold, name: str) -> uuid.UUID:
    async with household_session(h.household_id) as db:
        pid: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, :n, '🦊', '#f97316') RETURNING id"
                ),
                {"h": h.household_id, "n": f"{name}-{uuid.uuid4().hex[:6]}"},
            )
        ).scalar_one()
    return pid


async def _joined(p: Phone, h: SeededHousehold) -> uuid.UUID:
    resp = await p.join(h.slug, CODE)
    assert resp.status_code == 200, resp.text
    return uuid.UUID(resp.json()["device_id"])


async def _night(h: SeededHousehold) -> None:
    await open_night(h.household_id, h.ids["session"], CODE)


async def _row(h: SeededHousehold, sql: str, **params: Any) -> Any:
    async with household_session(h.household_id) as db:
        return (await db.execute(text(sql), params)).first()


async def _send(p: Phone, method: str, path: str, body: dict[str, Any] | None = None) -> Response:
    return await p.client.request(method, path, json=body, headers={CSRF_HEADER: await p.csrf()})


def _grid(resp: Response) -> dict[str, dict[str, Any]]:
    return {t["id"]: t for t in resp.json()}


# --- First claim and claiming elsewhere -----------------------------------------------


async def test_first_claim_must_set_a_pin_and_it_is_stored_hashed(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as p:
        await _joined(p, a)
        no_pin = await p.bind(mia, pin=None)
        bad_format = await p.bind(mia, pin="12345")
        ok = await p.bind(mia)
        tile = _grid(await p.client.get("/api/v1/people"))[str(mia)]
    assert no_pin.status_code == 422
    assert "Choose a 6-digit PIN" in no_pin.json()["error"]["message"]
    assert bad_format.status_code == 422
    assert ok.json() == {"person_id": str(mia), "status": "active", "current": True}
    assert tile | {"name": None} == {
        "id": str(mia),
        "name": None,
        "avatar_emoji": "🦊",
        "color": "#f97316",
        "is_guest": False,
        "binding": "mine",
        "has_pin": True,
        "locked": False,
        "current": True,
        "can_rename": True,
    }
    row = await _row(a, "SELECT pin_hash, pin_set_at FROM people WHERE id = :p", p=mia)
    assert row.pin_hash.startswith("$argon2id$") and TEST_PIN not in row.pin_hash
    assert row.pin_set_at is not None


async def test_the_right_pin_claims_on_another_phone_without_a_host(two_households: Pair) -> None:
    """ADR-0014 replaces host approval for people with a PIN; both phones can act as them."""
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as kid, phone() as parent:
        await _joined(kid, a)
        await _joined(parent, a)
        await kid.bind(mia)
        resp = await parent.bind(mia)
        kid_tile = _grid(await kid.client.get("/api/v1/people"))[str(mia)]
    assert resp.json() == {"person_id": str(mia), "status": "active", "current": True}
    assert kid_tile["current"] is True  # the kid's own phone keeps acting as them


async def test_a_phone_cannot_set_the_pin_of_someone_another_phone_holds(
    two_households: Pair,
) -> None:
    """No PIN yet and bound elsewhere (people from before PINs): a PIN from a new phone
    would be a takeover, so it waits for a host and the PIN is not set."""
    a, _ = two_households
    await _night(a)
    async with phone() as p:
        await _joined(p, a)
        resp = await p.bind(a.ids["person"])  # the seed binds Kid to its own device
    assert resp.json() == {"person_id": str(a.ids["person"]), "status": "pending", "current": False}
    row = await _row(a, "SELECT pin_hash FROM people WHERE id = :p", p=a.ids["person"])
    assert row.pin_hash is None


async def test_existing_binding_without_a_pin_must_set_one_before_acting(
    two_households: Pair,
) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as p:
        device = await _joined(p, a)
        # A binding from before PINs existed: active, not current, no PIN.
        async with household_session(a.household_id) as db:
            await db.execute(
                text(
                    "INSERT INTO device_people (household_id, device_id, person_id) "
                    "VALUES (:h, :d, :p)"
                ),
                {"h": a.household_id, "d": device, "p": mia},
            )
        tile = _grid(await p.client.get("/api/v1/people"))[str(mia)]
        vote = await _send(
            p,
            "PUT",
            f"/api/v1/sessions/{a.ids['session']}/ballots",
            {"person_id": str(mia), "ranks": [{"option_id": str(a.ids["option"]), "rank": 1}]},
        )
        set_pin = await _send(p, "POST", f"{ME}/{mia}/pin", {"new_pin": TEST_PIN})
        after = _grid(await p.client.get("/api/v1/people"))[str(mia)]
    assert (tile["binding"], tile["has_pin"], tile["current"]) == ("mine", False, False)
    assert vote.status_code == 403
    assert vote.json()["error"]["message"] == "Set a PIN for them on this phone first"
    assert set_pin.json() == {"person_id": str(mia), "status": "active", "current": True}
    assert (after["has_pin"], after["current"]) == (True, True)


async def test_switching_on_a_shared_phone_needs_the_pin(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia, leo = await _person(a, "Mia"), await _person(a, "Leo")
    async with phone() as p:
        await _joined(p, a)
        await p.bind(mia, pin="111111")
        await p.bind(leo, pin="222222")
        no_pin = await p.bind(mia, pin=None)
        wrong = await p.bind(mia, pin="222222")
        right = await p.bind(mia, pin="111111")
        again = await p.bind(mia, pin=None)  # already current: nothing to do
        grid = _grid(await p.client.get("/api/v1/people"))
    assert no_pin.status_code == 422
    assert "PIN to switch" in no_pin.json()["error"]["message"]
    assert wrong.status_code == 403
    assert right.json()["current"] is True
    assert again.json() == {"person_id": str(mia), "status": "active", "current": True}
    assert (grid[str(mia)]["current"], grid[str(leo)]["current"]) == (True, False)


async def test_changing_a_pin_needs_the_current_one(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as p:
        await _joined(p, a)
        await p.bind(mia)
        missing = await _send(p, "POST", f"{ME}/{mia}/pin", {"new_pin": "999999"})
        wrong = await _send(
            p, "POST", f"{ME}/{mia}/pin", {"new_pin": "999999", "current_pin": WRONG}
        )
        ok = await _send(
            p, "POST", f"{ME}/{mia}/pin", {"new_pin": "999999", "current_pin": TEST_PIN}
        )
    async with phone() as other:
        await _joined(other, a)
        old = await other.bind(mia)
        new = await other.bind(mia, pin="999999")
    assert (missing.status_code, wrong.status_code, ok.status_code) == (422, 403, 200)
    assert old.status_code == 403
    assert new.json()["status"] == "active"


async def test_set_pin_needs_a_binding_on_this_phone(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as p:
        await _joined(p, a)
        resp = await _send(p, "POST", f"{ME}/{mia}/pin", {"new_pin": TEST_PIN})
    assert resp.status_code == 403
    assert resp.json()["error"]["message"] == "This phone isn't set to them"


# --- Wrong PINs and the lock --------------------------------------------------------


async def test_wrong_pins_count_and_lock_the_profile_at_five(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as owner, phone() as thief:
        await _joined(owner, a)
        await _joined(thief, a)
        await owner.bind(mia)
        tries = [await thief.bind(mia, pin=WRONG) for _ in range(5)]
        right_pin = await thief.bind(mia)
        grid = _grid(await owner.client.get("/api/v1/people"))
        # The owner's phone still acts as them: a lock gates PIN entry, not everyday use.
        owner_switch = await owner.bind(mia, pin=None)

    assert [r.status_code for r in tries] == [403, 403, 403, 403, 423]
    assert [r.json()["error"]["attempts_left"] for r in tries] == [4, 3, 2, 1, 0]
    assert tries[0].json()["error"]["code"] == "wrong_pin"
    assert tries[0].json()["error"]["message"].startswith("Wrong PIN. 4 tries left")
    assert tries[3].json()["error"]["message"].startswith("Wrong PIN. 1 try left")
    assert tries[4].json()["error"]["code"] == "pin_locked"
    # Locked: even the right PIN is refused.
    assert right_pin.status_code == 423
    assert "Ask an admin to reset the PIN" in right_pin.json()["error"]["message"]
    assert grid[str(mia)]["locked"] is True
    assert owner_switch.json()["current"] is True
    row = await _row(
        a, "SELECT pin_failed_attempts, pin_locked_at FROM people WHERE id = :p", p=mia
    )
    assert row.pin_failed_attempts == 5 and row.pin_locked_at is not None
    audit = await _row(
        a,
        "SELECT count(*) FILTER (WHERE action = 'person.pin_failed') AS failed, "
        "count(*) FILTER (WHERE action = 'person.pin_locked') AS locked "
        "FROM audit_events WHERE target_id = :p",
        p=mia,
    )
    assert (audit.failed, audit.locked) == (4, 1)


async def test_the_right_pin_resets_the_count(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as owner, phone() as p:
        await _joined(owner, a)
        await _joined(p, a)
        await owner.bind(mia)
        for _ in range(4):
            await p.bind(mia, pin=WRONG)
        ok = await p.bind(mia)
    assert ok.json()["status"] == "active"
    row = await _row(a, "SELECT pin_failed_attempts FROM people WHERE id = :p", p=mia)
    assert row.pin_failed_attempts == 0


async def test_one_phone_has_a_wrong_pin_budget_across_people(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    await _night(a)
    monkeypatch.setattr(settings, "PIN_FAILURE_LIMIT", 3)
    people = [await _person(a, f"P{i}") for i in range(3)]
    async with phone() as owner, phone() as p:
        await _joined(owner, a)
        await _joined(p, a)
        for pid in people:
            await owner.bind(pid)
        statuses = [(await p.bind(pid, pin=WRONG)).status_code for pid in people]
        blocked = await p.bind(people[0])  # right PIN, but this phone is out of budget
    assert statuses == [403, 403, 403]
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"]


# --- Forgot PIN and admin reset -------------------------------------------------------


async def test_forgot_pin_reset_flow(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as owner, phone() as kid, phone() as admin:
        await _joined(owner, a)
        kid_device = await _joined(kid, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        await owner.bind(mia)
        for _ in range(5):
            await kid.bind(mia, pin=WRONG)

        first = await _send(kid, "POST", f"{ME}/{mia}/forgot-pin")
        again = await _send(kid, "POST", f"{ME}/{mia}/forgot-pin")
        queue = (await admin.client.get(RESETS)).json()
        [mine] = [r for r in queue if r["person_id"] == str(mia)]
        approved = await _send(admin, "POST", f"{RESETS}/{mine['id']}/approve")
        twice = await _send(admin, "POST", f"{RESETS}/{mine['id']}/approve")
        queue_after = (await admin.client.get(RESETS)).json()
        # The phone that asked may set the new PIN even though the owner's phone holds Mia.
        claim = await kid.bind(mia, pin="864200")
        other = await kid.client.get("/api/v1/people")

    assert first.status_code == 202 and first.json()["status"] == "open"
    assert again.json()["id"] == first.json()["id"]  # idempotent while open
    assert mine | {"requested_at": None} == {
        "id": first.json()["id"],
        "person_id": str(mia),
        "person_name": mine["person_name"],
        "avatar_emoji": "🦊",
        "person_locked": True,
        "requested_by_device_id": str(kid_device),
        "device_label": None,
        "status": "open",
        "requested_at": None,
        "resolved_at": None,
    }
    assert approved.status_code == 200
    body = approved.json()
    assert body["status"] == "approved" and body["person_locked"] is False
    # Approval never reveals or sets a PIN.
    assert not any("pin" in k and k != "person_locked" for k in body)
    assert TEST_PIN not in approved.text and "argon2" not in approved.text
    assert twice.status_code == 409
    assert str(mia) not in {r["person_id"] for r in queue_after}
    assert claim.json() == {"person_id": str(mia), "status": "active", "current": True}
    assert _grid(other)[str(mia)]["locked"] is False
    audit = await _row(
        a,
        "SELECT actor_account_id, data FROM audit_events "
        "WHERE action = 'person.pin_reset' AND target_id = :p",
        p=mia,
    )
    assert audit.actor_account_id == a.ids["account"]
    assert audit.data == {"request": first.json()["id"]}


async def test_after_a_reset_other_phones_still_cannot_set_the_pin(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as owner, phone() as asker, phone() as stranger, phone() as admin:
        await _joined(owner, a)
        await _joined(asker, a)
        await _joined(stranger, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        await owner.bind(mia)
        rid = (await _send(asker, "POST", f"{ME}/{mia}/forgot-pin")).json()["id"]
        await _send(admin, "POST", f"{RESETS}/{rid}/approve")
        stranger_claim = await stranger.bind(mia, pin="111111")
        # The owner's phone still holds Mia and may set a new PIN on it.
        owner_set = await _send(owner, "POST", f"{ME}/{mia}/pin", {"new_pin": "222222"})
    assert stranger_claim.json()["status"] == "pending"
    assert owner_set.json()["current"] is True


async def test_dismissing_a_reset_changes_nothing(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as owner, phone() as admin:
        await _joined(owner, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        await owner.bind(mia)
        rid = (await _send(owner, "POST", f"{ME}/{mia}/forgot-pin")).json()["id"]
        dismissed = await _send(admin, "POST", f"{RESETS}/{rid}/dismiss")
        approve_after = await _send(admin, "POST", f"{RESETS}/{rid}/approve")
    assert dismissed.json()["status"] == "dismissed"
    assert approve_after.status_code == 409
    row = await _row(a, "SELECT pin_hash FROM people WHERE id = :p", p=mia)
    assert row.pin_hash is not None


async def test_only_admins_handle_resets(two_households: Pair) -> None:
    a, _ = two_households
    rid = a.ids["pin_reset_request"]
    host_id = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@x.test")
    async with phone() as host, phone() as device:
        host.sign_in_as(host_id, a.household_id)
        listed = await host.client.get(RESETS)
        approve = await _send(host, "POST", f"{RESETS}/{rid}/approve")
        await _night(a)
        await _joined(device, a)
        device_list = await device.client.get(RESETS)
    assert (listed.status_code, approve.status_code) == (403, 403)
    assert device_list.status_code == 401


# --- Rename once and self-create ------------------------------------------------------


async def test_a_person_may_rename_themselves_once(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    new_name = f"Mia B {uuid.uuid4().hex[:4]}"
    async with phone() as p, phone() as admin:
        await _joined(p, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        not_mine = await _send(p, "PATCH", f"{ME}/{mia}", {"name": "Nope"})
        await p.bind(mia)
        first = await _send(p, "PATCH", f"{ME}/{mia}", {"name": new_name})
        second = await _send(p, "PATCH", f"{ME}/{mia}", {"name": "Third Try"})
        # Admins can still rename (and it does not reopen the self-rename).
        by_admin = await _send(admin, "PATCH", f"/api/v1/admin/people/{mia}", {"name": "Mimi X"})
        third = await _send(p, "PATCH", f"{ME}/{mia}", {"name": "Fourth Try"})
    assert not_mine.status_code == 403
    assert first.status_code == 200
    assert (first.json()["name"], first.json()["can_rename"]) == (new_name, False)
    assert second.status_code == 409
    assert "already changed your name" in second.json()["error"]["message"]
    assert by_admin.status_code == 200
    assert third.status_code == 409
    row = await _row(a, "SELECT name FROM people WHERE id = :p", p=mia)
    assert row.name == "Mimi X"


async def test_rename_respects_household_name_uniqueness(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    mia = await _person(a, "Mia")
    async with phone() as p:
        await _joined(p, a)
        await p.bind(mia)
        clash = await _send(p, "PATCH", f"{ME}/{mia}", {"name": "kid"})  # the seed's "Kid"
        same = await _send(p, "PATCH", f"{ME}/{mia}", {"name": "  "})
    assert clash.status_code == 409
    assert same.status_code == 422
    row = await _row(a, "SELECT name_changed_at FROM people WHERE id = :p", p=mia)
    assert row.name_changed_at is None  # a refused rename does not use up the one change


async def test_a_joined_phone_can_create_a_guest_profile(two_households: Pair) -> None:
    a, _ = two_households
    await _night(a)
    name = f"Cousin {uuid.uuid4().hex[:6]}"
    body = {"name": name, "avatar_emoji": "🐙", "color": "#22C55E", "pin": TEST_PIN}
    async with phone() as p, phone() as other:
        device = await _joined(p, a)
        no_pin = await _send(p, "POST", ME, {k: v for k, v in body.items() if k != "pin"})
        created = await _send(p, "POST", ME, body)
        duplicate = await _send(p, "POST", ME, body | {"name": name.upper()})
        await _joined(other, a)
        claimed_elsewhere = await other.bind(uuid.UUID(created.json()["id"]))
    assert no_pin.status_code == 422
    assert created.status_code == 201
    out = created.json()
    assert (out["is_guest"], out["binding"], out["current"], out["has_pin"]) == (
        True,
        "mine",
        True,
        True,
    )
    assert out["color"] == "#22c55e"
    assert duplicate.status_code == 409
    assert claimed_elsewhere.json()["status"] == "active"  # with the PIN they chose
    audit = await _row(
        a,
        "SELECT actor_device_id FROM audit_events WHERE action = 'person.self_created' "
        "AND target_id = :p",
        p=uuid.UUID(out["id"]),
    )
    assert audit.actor_device_id == device


async def test_self_create_is_budgeted_per_phone(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    await _night(a)
    monkeypatch.setattr(settings, "SELF_CREATE_LIMIT", 2)
    async with phone() as p:
        await _joined(p, a)
        codes = []
        for i in range(3):
            body = {
                "name": f"G{i} {uuid.uuid4().hex[:6]}",
                "avatar_emoji": "🐙",
                "color": "#22c55e",
                "pin": TEST_PIN,
            }
            codes.append((await _send(p, "POST", ME, body)).status_code)
    assert codes == [201, 201, 429]


async def test_new_device_routes_need_a_device_and_csrf(two_households: Pair) -> None:
    a, _ = two_households
    pid = a.ids["person"]
    async with phone() as p:
        await p.csrf()
        no_device = await _send(p, "POST", f"{ME}/{pid}/forgot-pin")
        await _night(a)
        await _joined(p, a)
        no_csrf = await p.client.post(f"{ME}/{pid}/forgot-pin")
    assert no_device.status_code == 401
    assert no_csrf.status_code == 403


# --- Household isolation (ADR-0003: 404, never 403) ---------------------------------


async def test_every_new_route_is_404_for_another_households_person(two_households: Pair) -> None:
    a, b = two_households
    await _night(a)
    theirs = b.ids["person"]
    reset_b = b.ids["pin_reset_request"]
    async with phone() as p, phone() as admin:
        await _joined(p, a)
        admin.sign_in_as(a.ids["account"], a.household_id)
        responses = {
            "claim": await p.bind(theirs),
            "claim_no_pin": await p.bind(theirs, pin=None),
            "rename": await _send(p, "PATCH", f"{ME}/{theirs}", {"name": "X Y"}),
            "set_pin": await _send(p, "POST", f"{ME}/{theirs}/pin", {"new_pin": TEST_PIN}),
            "forgot": await _send(p, "POST", f"{ME}/{theirs}/forgot-pin"),
            "profile_device": await p.client.get(f"/api/v1/people/{theirs}/profile"),
            "profile_account": await admin.client.get(f"/api/v1/people/{theirs}/profile"),
            "approve": await _send(admin, "POST", f"{RESETS}/{reset_b}/approve"),
            "dismiss": await _send(admin, "POST", f"{RESETS}/{reset_b}/dismiss"),
        }
        queue = (await admin.client.get(RESETS)).json()
    assert {k: r.status_code for k, r in responses.items()} == {
        "claim": 404,
        "claim_no_pin": 404,
        "rename": 404,
        "set_pin": 404,
        "forgot": 404,
        "profile_device": 404,
        "profile_account": 404,
        "approve": 404,
        "dismiss": 404,
    }
    assert str(reset_b) not in {r["id"] for r in queue}
    row = await _row(b, "SELECT status FROM pin_reset_requests WHERE id = :r", r=reset_b)
    assert row.status == "open"
