"""The platform owner (ADR-0016, option A): a separate sign-in, a metadata-only list, and
entering one household at a time as its admin (minus accounts, nights and proxy votes), with
every entry and write audited where the family can see it."""

from __future__ import annotations

import time
import uuid

import pytest
from httpx import Response
from sqlalchemy import text

from app import cli
from app.core import hashing
from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.core.security import (
    CSRF_HEADER,
    PLATFORM_COOKIE,
    PlatformClaims,
    sign_platform_session,
    verify_platform_session,
)
from tests.integration.phones import Phone, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_auth import Outbox, outbox, verify

pytestmark = pytest.mark.integration

__all__ = ["outbox"]

Pair = tuple[SeededHousehold, SeededHousehold]
PASSWORD = "the operator's long password"
PLATFORM = "/api/v1/platform"
CODE = "K7M2QX"


async def _set_password(house: SeededHousehold) -> None:
    async with household_session(house.household_id) as db:
        await db.execute(
            text("UPDATE accounts SET password_hash = :h WHERE id = :a"),
            {"h": await hashing.hash_password(PASSWORD), "a": house.ids["account"]},
        )


async def _operator(house: SeededHousehold) -> None:
    """House's admin, with a password, granted through the CLI path."""
    await _set_password(house)
    await cli.grant_platform(house.account_email, "test suite")


async def _login(p: Phone, house: SeededHousehold, password: str = PASSWORD) -> Response:
    return await p.post(
        f"{PLATFORM}/login", {"username_or_email": house.account_email, "password": password}
    )


async def _audit(house: SeededHousehold, action: str) -> list[dict[str, object]]:
    async with household_session(house.household_id) as db:
        rows = await db.scalars(
            text("SELECT data FROM audit_events WHERE action = :a ORDER BY created_at"),
            {"a": action},
        )
        return list(rows)


async def test_only_an_operator_gets_a_platform_session(two_households: Pair) -> None:
    a, b = two_households
    await _operator(a)
    await _set_password(b)  # B's admin has a password but isn't an operator
    async with phone() as p:
        assert (await _login(p, b)).status_code == 401
        assert (await _login(p, a, "wrong")).status_code == 401
        # A family session is not a platform session.
        p.sign_in_as(a.ids["account"], a.household_id)
        assert (await p.client.get(f"{PLATFORM}/households")).status_code == 401

        signed_in = await _login(p, a)
        assert signed_in.status_code == 200, signed_in.text
        assert signed_in.json()["entered_household_id"] is None
        assert p.client.cookies.get(PLATFORM_COOKIE)

        listed = {h["id"]: h for h in (await p.client.get(f"{PLATFORM}/households")).json()}
    assert set(listed[str(b.household_id)]) == {
        "id",
        "name",
        "created_at",
        "disabled_at",
        "delete_after",
        "people",
        "devices",
        "nights",
        "photos",
        "last_activity",
    }
    assert listed[str(b.household_id)]["people"] == 1
    assert listed[str(b.household_id)]["photos"] == 1


async def test_entering_acts_as_admin_of_that_household_only(two_households: Pair) -> None:
    a, b = two_households
    await _operator(a)
    async with phone() as p:
        await _login(p, a)
        entered = await p.post(f"{PLATFORM}/households/{b.household_id}/enter")
        assert entered.status_code == 200, entered.text
        assert entered.json()["entered_household_name"] == "Family b"

        me = (await p.client.get("/api/v1/auth/me")).json()
        assert me["household_name"] == "Family b"
        assert me["platform_access"] is True
        assert me["consent"]["account_accepted"] is True

        people = (await p.client.get("/api/v1/admin/people")).json()
        assert [x["id"] for x in people] == [str(b.ids["person"])]
        renamed = await p.patch(f"/api/v1/admin/people/{b.ids['person']}", {"name": "Kiddo"})
        assert renamed.status_code == 200, renamed.text
        # Household A is out of reach while inside B.
        other = await p.patch(f"/api/v1/admin/people/{a.ids['person']}", {"name": "Nope"})
        assert other.status_code == 404

        # Not in platform access: accounts, nights, proxy votes, the family's own answers.
        denied = [
            await p.post(
                "/api/v1/admin/accounts",
                {"email": "x@ex.test", "display_name": "X", "role": "host"},
            ),
            await p.post("/api/v1/sessions", {}),
            await p.post("/api/v1/auth/password", {"new_password": "another long password"}),
            await p.post(
                "/api/v1/auth/consent",
                {"terms_version": "x", "privacy_version": "x", "guardian": True},
            ),
            await p.post(f"/api/v1/admin/people/pin-resets/{b.ids['pin_reset_request']}/approve"),
        ]
        assert [r.status_code for r in denied] == [403] * 5

        exited = await p.post(f"{PLATFORM}/exit")
        assert exited.json()["entered_household_id"] is None
        assert (await p.client.get("/api/v1/admin/people")).status_code == 401

    entered_rows = await _audit(b, "platform.entered")
    assert entered_rows == [{"via": "platform"}]
    assert await _audit(b, "person.updated") == [{"fields": ["name"], "via": "platform"}]
    assert len(await _audit(b, "platform.exited")) == 1

    async with AsyncSessionLocal() as session:
        actions = list(
            await session.scalars(
                text(
                    "SELECT action FROM platform_audit_events WHERE account_id = :a "
                    "ORDER BY created_at"
                ),
                {"a": a.ids["account"]},
            )
        )
    assert actions == [
        "platform.granted",
        "platform.signed_in",
        "platform.entered",
        "platform.exited",
    ]


async def test_revoking_or_disabling_the_operator_ends_the_session(two_households: Pair) -> None:
    a, b = two_households
    await _operator(a)
    async with phone() as p:
        await _login(p, a)
        await p.post(f"{PLATFORM}/households/{b.household_id}/enter")
        assert (await p.client.get("/api/v1/admin/people")).status_code == 200
        await cli.revoke_platform(a.account_email)
        assert (await p.client.get("/api/v1/admin/people")).status_code == 401
        assert (await p.client.get(f"{PLATFORM}/households")).status_code == 401


def test_a_platform_session_never_outlives_its_hours() -> None:
    now = int(time.time())
    ids = (uuid.uuid4(), uuid.uuid4())
    fresh = sign_platform_session(PlatformClaims(*ids, None, now))
    stale = sign_platform_session(
        PlatformClaims(*ids, uuid.uuid4(), now - settings.PLATFORM_SESSION_HOURS * 3600)
    )
    assert verify_platform_session(fresh, now) is not None
    assert verify_platform_session(stale, now) is None
    # An account cookie's shape never verifies as a platform one.
    assert verify_platform_session(f"{ids[0]}.{ids[1]}.{now}.abc", now) is None


async def test_operator_creates_a_household_whose_admin_is_invited(
    two_households: Pair, outbox: Outbox
) -> None:
    a, _ = two_households
    await _operator(a)
    email = f"new.admin.{uuid.uuid4().hex[:8]}@example.test"
    async with phone() as p:
        await _login(p, a)
        created = await p.post(
            f"{PLATFORM}/households",
            {"name": "The New Family", "admin_email": email, "admin_name": "Pat"},
        )
        assert created.status_code == 201, created.text
        household_id = uuid.UUID(created.json()["id"])
        taken = await p.post(
            f"{PLATFORM}/households",
            {"name": "Again", "admin_email": email, "admin_name": "Pat"},
        )
        assert taken.status_code == 409
    try:
        [message] = outbox.sent
        assert message.to == email
        assert "invite=1" in message.text
        async with phone() as admin:
            signed_in = await verify(admin, outbox.token_for(email))
            assert signed_in.status_code == 200, signed_in.text
            # A new household starts with its consent gate closed (ADR-0017 §2).
            assert signed_in.json()["consent"]["household_accepted"] is False
            assert signed_in.json()["consent"]["account_accepted"] is False
    finally:
        async with household_session(household_id) as db:
            await db.execute(text("DELETE FROM households WHERE id = :h"), {"h": household_id})


async def test_a_disabled_household_refuses_sign_ins_and_joins(
    two_households: Pair, outbox: Outbox
) -> None:
    a, b = two_households
    await _operator(a)
    await _set_password(b)
    await open_night(b.household_id, b.ids["session"], CODE)
    async with phone() as p:
        await _login(p, a)
        no_reason = await p.post(f"{PLATFORM}/households/{b.household_id}/disable", {"reason": " "})
        assert no_reason.status_code == 422
        off = await p.post(
            f"{PLATFORM}/households/{b.household_id}/disable", {"reason": "Unpaid hosting"}
        )
        assert off.status_code == 200, off.text
        assert off.json()["disabled_at"] is not None
    assert "Unpaid hosting" in outbox.sent[0].text

    async with phone() as family:
        login = await family.post(
            "/api/v1/auth/login", {"username_or_email": b.account_email, "password": PASSWORD}
        )
        assert login.status_code == 403
        assert login.json()["error"]["code"] == "household_disabled"
        family.sign_in_as(b.ids["account"], b.household_id)
        assert (await family.client.get("/api/v1/auth/me")).status_code == 401
    async with phone() as kid:
        joined = await kid.join(b.slug, CODE)
        assert joined.status_code == 403

    async with phone() as p:
        await _login(p, a)
        on = await p.post(f"{PLATFORM}/households/{b.household_id}/enable")
        assert on.status_code == 200
        assert on.json()["disabled_at"] is None
    async with phone() as family:
        login = await family.post(
            "/api/v1/auth/login", {"username_or_email": b.account_email, "password": PASSWORD}
        )
        assert login.status_code == 200


async def test_rotating_a_slug_kills_the_old_fridge_qr(two_households: Pair) -> None:
    a, b = two_households
    await _operator(a)
    async with phone() as p:
        await _login(p, a)
        resp = await p.client.post(
            f"{PLATFORM}/households/{b.household_id}/rotate-slug",
            headers={CSRF_HEADER: await p.csrf()},
        )
        assert resp.status_code == 204
    async with household_session(b.household_id) as db:
        slug = await db.scalar(text("SELECT join_slug FROM households"))
    assert slug != b.slug
    assert await _audit(b, "household.join_slug_rotated") == [{"via": "platform"}]
