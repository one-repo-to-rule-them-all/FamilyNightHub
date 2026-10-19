"""Hosts and admins (issue #71): invite by email, list, change role, remove access. The
invitee sets their own password from the emailed link; the last admin can't be removed."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.security import CSRF_HEADER, DEVICE_ONLY_HEADER
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_auth import NEW_PASSWORD, Outbox, outbox, verify

pytestmark = pytest.mark.integration

__all__ = ["outbox"]  # the fixture, re-exported for pytest

Pair = tuple[SeededHousehold, SeededHousehold]
ACCOUNTS = "/api/v1/admin/accounts"


def _email(tag: str) -> str:
    return f"{tag}.{uuid.uuid4().hex[:10]}@example.test"


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _invite(p: Phone, email: str, role: str = "host", **extra: Any) -> Response:
    return await p.post(ACCOUNTS, {"email": email, "display_name": "Abuela", "role": role, **extra})


async def _delete(p: Phone, account_id: uuid.UUID | str) -> Response:
    return await p.client.delete(f"{ACCOUNTS}/{account_id}", headers={CSRF_HEADER: await p.csrf()})


async def _audit(house: SeededHousehold, target: uuid.UUID | str) -> list[Any]:
    async with household_session(house.household_id) as db:
        rows = await db.execute(
            text(
                "SELECT action, data FROM audit_events WHERE target_id = :t "
                "ORDER BY created_at, action"
            ),
            {"t": uuid.UUID(str(target))},
        )
        return list(rows.all())


async def test_admin_invites_a_host_who_sets_their_own_password(
    two_households: Pair, outbox: Outbox
) -> None:
    a, _ = two_households
    email = _email("Host")
    async with phone() as p:
        _as_admin(p, a)
        resp = await _invite(p, email.upper(), username="Tio.Rafa")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["email"] == email.lower()
        assert body["username"] == "tio.rafa"
        assert body["role"] == "host"
        assert body["status"] == "invited"
        assert body["is_you"] is False
        assert body["invite_expires_at"] is not None
        # The response never carries the link.
        assert "token" not in resp.text

    [message] = outbox.sent
    assert message.to == email.lower()
    assert "invite=1" in message.text
    assert "Family a" in message.subject

    async with phone() as invitee:
        signed_in = await verify(invitee, outbox.token_for(email))
        assert signed_in.status_code == 200, signed_in.text
        assert signed_in.json()["role"] == "host"
        # A host runs nights but can't manage accounts.
        assert (await invitee.client.get(ACCOUNTS)).status_code == 403

    async with phone() as p:
        _as_admin(p, a)
        listed = {x["email"]: x for x in (await p.client.get(ACCOUNTS)).json()}
    assert listed[email.lower()]["status"] == "active"
    assert listed[email.lower()]["invite_expires_at"] is None
    assert listed[a.account_email]["is_you"] is True
    actions = [r.action for r in await _audit(a, body["id"])]
    assert actions[0] == "account.invited"
    assert "account.password_set" in actions
    [password_set] = [r for r in await _audit(a, body["id"]) if r.action == "account.password_set"]
    assert password_set.data == {"via": "invite"}


async def test_only_admins_reach_accounts(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", _email("h"))
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await p.client.get(ACCOUNTS)).status_code == 403
        assert (await _invite(p, _email("x"))).status_code == 403
        assert (await p.patch(f"{ACCOUNTS}/{host}", {"role": "admin"})).status_code == 403
        assert (await _delete(p, a.ids["account"])).status_code == 403
    async with phone() as p:
        _as_admin(p, a)
        # The TV window never acts as the account.
        tv = await p.client.get(ACCOUNTS, headers={DEVICE_ONLY_HEADER: "1"})
        assert tv.status_code == 401
        # CSRF on every mutation.
        bare = await p.client.post(
            ACCOUNTS, json={"email": _email("y"), "display_name": "Y", "role": "host"}
        )
        assert bare.status_code == 403
    assert outbox.sent == []


async def test_invite_rejects_taken_addresses(two_households: Pair, outbox: Outbox) -> None:
    a, b = two_households
    async with phone() as p:
        _as_admin(p, a)
        assert (await _invite(p, a.account_email)).status_code == 409
        # Unique across households: login must stay unambiguous.
        assert (await _invite(p, b.account_email)).status_code == 409
        bad = await p.post(ACCOUNTS, {"email": "nope", "display_name": "N", "role": "host"})
        assert bad.status_code == 422
        bad_role = await p.post(
            ACCOUNTS, {"email": _email("r"), "display_name": "R", "role": "owner"}
        )
        assert bad_role.status_code == 422
    assert outbox.sent == []


async def test_role_changes_and_the_last_admin(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", _email("h"))
    me = a.ids["account"]
    async with phone() as p:
        _as_admin(p, a)
        # The only admin can't demote or remove themself.
        demote_me = await p.patch(f"{ACCOUNTS}/{me}", {"role": "host"})
        assert demote_me.status_code == 409
        assert "at least one admin" in demote_me.json()["error"]["message"]
        assert (await _delete(p, me)).status_code == 409

        promoted = await p.patch(f"{ACCOUNTS}/{host}", {"role": "admin"})
        assert promoted.status_code == 200
        assert promoted.json()["role"] == "admin"
        # With a second admin, stepping down is allowed.
        assert (await p.patch(f"{ACCOUNTS}/{me}", {"role": "host"})).status_code == 200
        # And the role is re-read on the next request: now a host.
        assert (await p.client.get(ACCOUNTS)).status_code == 403

    async with phone() as other:
        other.sign_in_as(host, a.household_id)
        assert (await _delete(other, host)).status_code == 409  # the last admin again
        assert (await other.patch(f"{ACCOUNTS}/{me}", {"role": "admin"})).status_code == 200
    audit = await _audit(a, host)
    assert [r.data for r in audit if r.action == "account.role_changed"] == [
        {"from": "host", "to": "admin"}
    ]


async def test_remove_access_and_reinvite(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    email = _email("gone")
    async with phone() as p:
        _as_admin(p, a)
        invited = (await _invite(p, email)).json()
    async with phone() as invitee:
        assert (await verify(invitee, outbox.token_for(email))).status_code == 200
        assert (await invitee.client.get("/api/v1/auth/me")).status_code == 200

        async with phone() as p:
            _as_admin(p, a)
            assert (await _delete(p, invited["id"])).status_code == 204
            listed = [x["email"] for x in (await p.client.get(ACCOUNTS)).json()]
            assert email not in listed
            assert (await _delete(p, invited["id"])).status_code == 404

        # The signed-in browser stops working on its next request.
        assert (await invitee.client.get("/api/v1/auth/me")).status_code == 401
        login = await invitee.post(
            "/api/v1/auth/login", {"username_or_email": email, "password": NEW_PASSWORD}
        )
        assert login.status_code == 401

    outbox.sent.clear()
    async with phone() as p:
        _as_admin(p, a)
        again = await _invite(p, email, role="admin")
        assert again.status_code == 201, again.text
        assert again.json()["id"] == invited["id"]
        assert again.json()["status"] == "invited"  # the old password is gone
        assert again.json()["role"] == "admin"
    async with phone() as invitee:
        login = await invitee.post(
            "/api/v1/auth/login", {"username_or_email": email, "password": NEW_PASSWORD}
        )
        assert login.status_code == 401
    actions = [r.action for r in await _audit(a, invited["id"])]
    assert "account.removed" in actions
    assert actions.count("account.invited") == 2


async def test_resend_replaces_the_link(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    email = _email("slow")
    async with phone() as p:
        _as_admin(p, a)
        invited = (await _invite(p, email)).json()
        first = outbox.token_for(email)
        outbox.sent.clear()
        resent = await p.post(f"{ACCOUNTS}/{invited['id']}/resend")
        assert resent.status_code == 200, resent.text
        second = outbox.token_for(email)
    assert first != second
    async with phone() as invitee:
        assert (await verify(invitee, first)).status_code == 400
        assert (await verify(invitee, second)).status_code == 200
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.post(f"{ACCOUNTS}/{invited['id']}/resend")).status_code == 409
    assert "account.invite_resent" in [r.action for r in await _audit(a, invited["id"])]


async def test_other_households_accounts_are_404(two_households: Pair, outbox: Outbox) -> None:
    a, b = two_households
    theirs = b.ids["account"]
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.patch(f"{ACCOUNTS}/{theirs}", {"role": "host"})).status_code == 404
        assert (await _delete(p, theirs)).status_code == 404
        assert (await p.post(f"{ACCOUNTS}/{theirs}/resend")).status_code == 404
        listed = [x["id"] for x in (await p.client.get(ACCOUNTS)).json()]
    assert str(theirs) not in listed
    assert outbox.sent == []


async def test_invites_are_budgeted_per_address(
    two_households: Pair, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "INVITE_EMAIL_LIMIT", 2)
    email = _email("spam")
    async with phone() as p:
        _as_admin(p, a)
        invited = (await _invite(p, email)).json()
        assert (await p.post(f"{ACCOUNTS}/{invited['id']}/resend")).status_code == 200
        throttled = await p.post(f"{ACCOUNTS}/{invited['id']}/resend")
        assert throttled.status_code == 429
        assert int(throttled.headers["Retry-After"]) > 0
    assert len(outbox.sent) == 2
