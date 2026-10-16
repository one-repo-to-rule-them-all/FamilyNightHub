"""Magic-link sign-in, the fnh_session cookie and CurrentAccount (ADR-0002)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from urllib.parse import parse_qs, urlparse

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.config import settings
from app.core.database import household_session
from app.core.security import (
    ACCOUNT_COOKIE,
    CSRF_HEADER,
    hash_magic_link_token,
    sign_account_session,
)
from app.integrations.email import Email, email_sender
from app.main import app
from tests.integration.phones import Phone, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]


class Outbox:
    def __init__(self) -> None:
        self.sent: list[Email] = []

    async def send(self, message: Email) -> None:
        self.sent.append(message)

    def token_for(self, address: str) -> str:
        [message] = [m for m in self.sent if m.to.lower() == address.lower()]
        link = next(line for line in message.text.splitlines() if "/auth/callback" in line)
        return parse_qs(urlparse(link).query)["token"][0]


@pytest.fixture
def outbox() -> Iterator[Outbox]:
    box = Outbox()
    app.dependency_overrides[email_sender] = lambda: box
    yield box
    app.dependency_overrides.pop(email_sender, None)


async def _post(p: Phone, path: str, body: dict[str, str] | None = None) -> Response:
    return await p.client.post(path, json=body, headers={CSRF_HEADER: await p.csrf()})


async def request_link(p: Phone, email: str) -> Response:
    return await _post(p, "/api/v1/auth/magic-link", {"email": email})


async def verify(p: Phone, token: str) -> Response:
    return await _post(p, "/api/v1/auth/verify", {"token": token})


async def sign_in(p: Phone, outbox: Outbox, email: str) -> None:
    assert (await request_link(p, email)).status_code == 202
    resp = await verify(p, outbox.token_for(email))
    assert resp.status_code == 200, resp.text


# --- Requesting a link -------------------------------------------------------------


async def test_known_email_gets_a_single_use_link(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p:
        resp = await request_link(p, a.account_email)
    assert resp.status_code == 202
    token = outbox.token_for(a.account_email)
    assert outbox.sent[0].text.count(token) == 1
    async with household_session(a.household_id) as db:
        stored = await db.scalar(
            text("SELECT count(*) FROM magic_links WHERE token_hash = :h AND used_at IS NULL"),
            {"h": hash_magic_link_token(token)},
        )
    assert stored == 1


async def test_unknown_email_gets_the_same_answer_and_no_mail(
    two_households: Pair, outbox: Outbox
) -> None:
    a, _ = two_households
    async with phone() as p:
        known = await request_link(p, a.account_email)
        unknown = await request_link(
            p, f"nobody.{a.slug}@example.test"
        )  # unique: budgets persist in Redis
    assert unknown.status_code == known.status_code == 202
    assert unknown.json() == known.json()
    assert [m.to for m in outbox.sent] == [a.account_email]


async def test_email_match_is_case_insensitive(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p:
        await request_link(p, f"  {a.account_email.upper()} ")
    assert len(outbox.sent) == 1


async def test_disabled_account_gets_no_link(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with household_session(a.household_id) as db:
        await db.execute(
            text("UPDATE accounts SET disabled_at = now() WHERE id = :a"), {"a": a.ids["account"]}
        )
    async with phone() as p:
        assert (await request_link(p, a.account_email)).status_code == 202
    assert outbox.sent == []


async def test_requests_are_budgeted_per_address_known_or_not(
    two_households: Pair, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "MAGIC_LINK_REQUEST_LIMIT", 2)
    stranger = f"stranger.{a.slug}@example.test"
    async with phone() as p:
        for address in (a.account_email, stranger):
            assert (await request_link(p, address)).status_code == 202
            assert (await request_link(p, address)).status_code == 202
            limited = await request_link(p, address)
            assert limited.status_code == 429
            assert int(limited.headers["retry-after"]) >= 1
    assert len(outbox.sent) == 2  # only the two allowed requests for the real account


# --- Verifying -------------------------------------------------------------------


async def test_verify_signs_in_with_a_hardened_cookie(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p:
        await request_link(p, a.account_email)
        resp = await verify(p, outbox.token_for(a.account_email))
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"
        assert resp.json()["household_name"] == "Family a"
        cookie = next(
            c for c in resp.headers.get_list("set-cookie") if c.startswith(ACCOUNT_COOKIE)
        ).lower()
        assert "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie
        me = await p.client.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json()["email"] == a.account_email


async def test_link_is_single_use(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p:
        await request_link(p, a.account_email)
        token = outbox.token_for(a.account_email)
        assert (await verify(p, token)).status_code == 200
        assert (await verify(p, token)).status_code == 400


async def test_two_tabs_racing_one_link_sign_in_once(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p1, phone() as p2:
        await request_link(p1, a.account_email)
        token = outbox.token_for(a.account_email)
        await p1.csrf()
        await p2.csrf()
        results = await asyncio.gather(verify(p1, token), verify(p2, token))
    assert sorted(r.status_code for r in results) == [200, 400]


@pytest.mark.parametrize("case", ["expired", "disabled", "garbage"])
async def test_bad_links_are_rejected(two_households: Pair, outbox: Outbox, case: str) -> None:
    a, _ = two_households
    async with phone() as p:
        await request_link(p, a.account_email)
        token = outbox.token_for(a.account_email)
        async with household_session(a.household_id) as db:
            if case == "expired":
                await db.execute(
                    text("UPDATE magic_links SET expires_at = now() - interval '1 second'")
                )
            if case == "disabled":
                await db.execute(text("UPDATE accounts SET disabled_at = now()"))
        if case == "garbage":
            token = "x" * 43
        resp = await verify(p, token)
    assert resp.status_code == 400
    assert resp.json()["error"]["message"] == "This sign-in link is invalid or has expired."


# --- The session ------------------------------------------------------------------


async def test_me_needs_a_valid_session(two_households: Pair) -> None:
    a, _ = two_households
    now = int(time.time())
    old = now - settings.ACCOUNT_SESSION_MAX_AGE_DAYS * 86400 - 1
    good = sign_account_session(a.ids["account"], a.household_id, now)
    cases = {
        "missing": None,
        "tampered": good[:-1] + ("0" if good[-1] != "0" else "1"),
        "expired": sign_account_session(a.ids["account"], a.household_id, old),
        "future": sign_account_session(a.ids["account"], a.household_id, now + 3600),
        "malformed": "not.a.session",
        "bad_uuid": "x.y.1.abc",
    }
    async with phone() as p:
        for name, value in cases.items():
            p.client.cookies.clear()
            if value is not None:
                p.client.cookies.set(ACCOUNT_COOKIE, value, domain="fnh.test")
            assert (await p.client.get("/api/v1/auth/me")).status_code == 401, name
        p.client.cookies.set(ACCOUNT_COOKIE, good, domain="fnh.test")
        assert (await p.client.get("/api/v1/auth/me")).status_code == 200


async def test_session_signed_with_another_secret_is_rejected(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, _ = two_households
    monkeypatch.setattr(settings, "SESSION_SECRET", "some-other-secret")
    forged = sign_account_session(a.ids["account"], a.household_id, int(time.time()))
    monkeypatch.undo()
    async with phone() as p:
        p.client.cookies.set(ACCOUNT_COOKIE, forged, domain="fnh.test")
        assert (await p.client.get("/api/v1/auth/me")).status_code == 401


async def test_disabling_an_account_ends_its_sessions(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p:
        await sign_in(p, outbox, a.account_email)
        async with household_session(a.household_id) as db:
            await db.execute(text("UPDATE accounts SET disabled_at = now()"))
        assert (await p.client.get("/api/v1/auth/me")).status_code == 401


async def test_session_cannot_be_pointed_at_another_household(two_households: Pair) -> None:
    """The household is signed into the cookie; swapping it breaks the MAC, and even a
    correctly signed account/household mismatch finds no account."""
    a, b = two_households
    now = int(time.time())
    mismatched = sign_account_session(a.ids["account"], b.household_id, now)
    async with phone() as p:
        p.client.cookies.set(ACCOUNT_COOKIE, mismatched, domain="fnh.test")
        assert (await p.client.get("/api/v1/auth/me")).status_code == 401


async def test_logout_clears_the_session(two_households: Pair, outbox: Outbox) -> None:
    a, _ = two_households
    async with phone() as p:
        await sign_in(p, outbox, a.account_email)
        assert (await _post(p, "/api/v1/auth/logout")).status_code == 204
        assert (await p.client.get("/api/v1/auth/me")).status_code == 401


@pytest.mark.parametrize(
    "path", ["/api/v1/auth/magic-link", "/api/v1/auth/verify", "/api/v1/auth/logout"]
)
async def test_auth_mutations_need_csrf(path: str) -> None:
    async with phone() as p:
        await p.csrf()
        resp = await p.client.post(path, json={"email": "a@b.co", "token": "x" * 43})
    assert resp.status_code == 403
