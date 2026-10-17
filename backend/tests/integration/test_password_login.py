"""Password sign-in for hosts and admins (ADR-0014): login, throttling, no enumeration,
set/change password, and the magic link as "forgot password"."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from httpx import Response
from sqlalchemy import text

from app.core import hashing
from app.core.config import settings
from app.core.database import household_session
from app.core.security import ACCOUNT_COOKIE, CSRF_HEADER
from app.integrations.email import email_sender
from app.main import app
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_auth import Outbox, request_link, verify

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
PASSWORD = "lantern popcorn friday"
BAD_LOGIN = "Wrong username, email or password."


@pytest.fixture
def outbox() -> Iterator[Outbox]:
    box = Outbox()
    app.dependency_overrides[email_sender] = lambda: box
    yield box
    app.dependency_overrides.pop(email_sender, None)


async def _with_password(h: SeededHousehold, password: str | None = PASSWORD) -> str:
    """Give the seeded admin a unique username (and a password); return the username."""
    username = f"host.{uuid.uuid4().hex[:10]}"
    async with household_session(h.household_id) as db:
        await db.execute(
            text("UPDATE accounts SET username = :u, password_hash = :p WHERE id = :a"),
            {
                "u": username,
                "p": await hashing.hash_password(password) if password else None,
                "a": h.ids["account"],
            },
        )
    return username


async def login(p: Phone, identifier: str, password: str) -> Response:
    return await p.client.post(
        "/api/v1/auth/login",
        json={"username_or_email": identifier, "password": password},
        headers={CSRF_HEADER: await p.csrf()},
    )


async def change(p: Phone, new: str, current: str | None = None) -> Response:
    body = {"new_password": new} | ({"current_password": current} if current else {})
    return await p.client.post(
        "/api/v1/auth/password", json=body, headers={CSRF_HEADER: await p.csrf()}
    )


# --- Login ------------------------------------------------------------------------


async def test_login_by_username_or_email_sets_the_session(two_households: Pair) -> None:
    a, _ = two_households
    username = await _with_password(a)
    async with phone() as p, phone() as q:
        by_name = await login(p, username.upper(), PASSWORD)
        cookie = next(
            c for c in by_name.headers.get_list("set-cookie") if c.startswith(ACCOUNT_COOKIE)
        ).lower()
        me = (await p.client.get("/api/v1/auth/me")).json()
        by_email = await login(q, f"  {a.account_email.upper()} ", PASSWORD)
    assert by_name.status_code == 200
    assert "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie
    assert (me["username"], me["has_password"], me["role"]) == (username, True, "admin")
    assert by_email.status_code == 200
    async with household_session(a.household_id) as db:
        methods = (
            (
                await db.execute(
                    text(
                        "SELECT data->>'method' FROM audit_events "
                        "WHERE action = 'account.signed_in' AND actor_account_id = :a"
                    ),
                    {"a": a.ids["account"]},
                )
            )
            .scalars()
            .all()
        )
    assert methods == ["password", "password"]


async def test_every_failure_looks_the_same(two_households: Pair) -> None:
    """No enumeration: unknown user, unknown email, wrong password, no password yet and a
    disabled account all get the same status and message."""
    a, b = two_households
    username = await _with_password(a)
    b_username = await _with_password(b, password=None)  # account without a password yet
    async with phone() as p:
        results = [
            await login(p, username, "wrong password here"),
            await login(p, f"nobody.{uuid.uuid4().hex[:8]}", PASSWORD),
            await login(p, f"nobody.{uuid.uuid4().hex[:8]}@example.test", PASSWORD),
            await login(p, b_username, PASSWORD),
        ]
        async with household_session(a.household_id) as db:
            await db.execute(
                text("UPDATE accounts SET disabled_at = now() WHERE id = :a"),
                {"a": a.ids["account"]},
            )
        results.append(await login(p, username, PASSWORD))
    assert {r.status_code for r in results} == {401}
    assert {r.json()["error"]["message"] for r in results} == {BAD_LOGIN}
    assert all(ACCOUNT_COOKIE not in r.headers.get("set-cookie", "") for r in results)


async def test_login_failures_are_throttled_per_identifier(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "LOGIN_FAILURE_LIMIT", 3)
    username = await _with_password(a)
    unknown = f"ghost.{uuid.uuid4().hex[:8]}"
    async with phone() as p:
        known = [(await login(p, username, "not the password")).status_code for _ in range(3)]
        blocked = await login(p, username, PASSWORD)  # right password, budget spent
        ghost = [(await login(p, unknown, "not the password")).status_code for _ in range(4)]
    assert known == [401, 401, 401]
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"]
    # The identifier budget treats an unknown name exactly like a known one.
    assert ghost == [401, 401, 401, 429]


async def test_login_failures_are_throttled_per_account_across_identifiers(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "LOGIN_FAILURE_LIMIT", 10)
    monkeypatch.setattr(settings, "LOGIN_ACCOUNT_FAILURE_LIMIT", 4)
    username = await _with_password(a)
    async with phone() as p:
        for ident in (username, a.account_email, username, a.account_email):
            assert (await login(p, ident, "not the password")).status_code == 401
        blocked = await login(p, username, PASSWORD)
    assert blocked.status_code == 429


async def test_login_needs_csrf(two_households: Pair) -> None:
    a, _ = two_households
    username = await _with_password(a)
    async with phone() as p:
        await p.csrf()
        resp = await p.client.post(
            "/api/v1/auth/login", json={"username_or_email": username, "password": PASSWORD}
        )
    assert resp.status_code == 403


# --- Set / change -------------------------------------------------------------------


async def test_first_password_then_change_needs_the_current_one(two_households: Pair) -> None:
    a, _ = two_households
    username = await _with_password(a, password=None)
    async with phone() as p, phone() as q:
        p.sign_in_as(a.ids["account"], a.household_id)
        weak = await change(p, "password1234")
        own_name = await change(p, username)
        first = await change(p, PASSWORD)
        no_current = await change(p, "second sturdy phrase")
        wrong_current = await change(p, "second sturdy phrase", "not it at all")
        ok = await change(p, "second sturdy phrase", PASSWORD)
        old = await login(q, username, PASSWORD)
        new = await login(q, username, "second sturdy phrase")
    assert weak.status_code == 422
    assert own_name.status_code == 422
    assert "username or email" in own_name.json()["error"]["message"]
    assert first.status_code == 204
    assert (no_current.status_code, wrong_current.status_code) == (403, 403)
    assert ok.status_code == 204
    assert (old.status_code, new.status_code) == (401, 200)


async def test_changing_a_password_needs_a_session_and_csrf() -> None:
    async with phone() as p:
        assert (await change(p, PASSWORD)).status_code == 401
        await p.csrf()
        resp = await p.client.post("/api/v1/auth/password", json={"new_password": PASSWORD})
    assert resp.status_code == 403


# --- Forgot password ----------------------------------------------------------------


async def test_forgot_password_link_sets_a_new_password(
    two_households: Pair, outbox: Outbox
) -> None:
    a, _ = two_households
    username = await _with_password(a)
    async with phone() as p, phone() as q:
        assert (await request_link(p, a.account_email)).status_code == 202
        token = outbox.token_for(a.account_email)
        weak = await verify(p, token, "password1234")
        missing = await p.client.post(
            "/api/v1/auth/verify", json={"token": token}, headers={CSRF_HEADER: await p.csrf()}
        )
        reset = await verify(p, token, "a brand new phrase")
        reused = await verify(p, token, "another new phrase")
        old = await login(q, username, PASSWORD)
        new = await login(q, username, "a brand new phrase")
    assert outbox.sent[0].subject == "Reset your Family Night password"
    assert (weak.status_code, missing.status_code) == (422, 422)
    # A refused password does not use the link up.
    assert reset.status_code == 200 and reset.json()["has_password"] is True
    assert reused.status_code == 400
    assert (old.status_code, new.status_code) == (401, 200)


async def test_reset_password_may_not_be_the_accounts_own_email(
    two_households: Pair, outbox: Outbox
) -> None:
    a, _ = two_households
    async with phone() as p:
        await request_link(p, a.account_email)
        token = outbox.token_for(a.account_email)
        own = await verify(p, token, a.account_email)
        ok = await verify(p, token, "fine and sturdy")
    assert own.status_code == 422
    assert ok.status_code == 200
