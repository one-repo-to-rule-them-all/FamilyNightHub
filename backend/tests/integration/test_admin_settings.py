"""Household settings and join-slug rotation (ADR-0002: admins rotate the slug)."""

from __future__ import annotations

import re

import pytest
from sqlalchemy import text

from app.core.database import household_session
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "SET234"
SETTINGS = "/api/v1/admin/settings"
ROTATE = "/api/v1/admin/join-slug/rotate"


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _audit(h: SeededHousehold, action: str) -> list[dict[str, object]]:
    async with household_session(h.household_id) as db:
        rows = await db.execute(
            text("SELECT data FROM audit_events WHERE action = :a ORDER BY created_at"),
            {"a": action},
        )
        return [r.data for r in rows]


async def test_admin_reads_and_patches_settings(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as p:
        _as_admin(p, a)
        resp = await p.client.get(SETTINGS)
        assert resp.status_code == 200
        initial = resp.json()
        assert initial["join_slug"] == a.slug
        assert initial["default_voting_method"] == "top3"
        assert initial["default_age_cap"] is None
        assert initial["region"] == "US"

        resp = await p.patch(SETTINGS, {"default_age_cap": "PG", "region": "mx"})
        assert resp.status_code == 200
        assert (resp.json()["default_age_cap"], resp.json()["region"]) == ("PG", "MX")
        # Fields left out stay; null clears the cap.
        resp = await p.patch(SETTINGS, {"default_age_cap": None})
        assert (resp.json()["default_age_cap"], resp.json()["region"]) == (None, "MX")
        assert (await p.patch(SETTINGS, {})).json()["region"] == "MX"
        assert (await p.patch(SETTINGS, {"default_voting_method": "top3"})).status_code == 200
    assert await _audit(a, "settings.updated") == [
        {
            "from": {"default_age_cap": None, "region": "US"},
            "to": {"default_age_cap": "PG", "region": "MX"},
        },
        {"from": {"default_age_cap": "PG"}, "to": {"default_age_cap": None}},
        {"from": {"default_voting_method": "top3"}, "to": {"default_voting_method": "top3"}},
    ]
    # The other household is untouched.
    async with phone() as p:
        _as_admin(p, b)
        assert (await p.client.get(SETTINGS)).json()["region"] == "US"


@pytest.mark.parametrize(
    "body",
    [
        {"default_voting_method": "approval"},  # Phase 2
        {"default_voting_method": "pick_one"},
        {"default_age_cap": "PG13"},
        {"region": "USA"},
        {"region": "1A"},
    ],
)
async def test_invalid_settings_are_rejected(two_households: Pair, body: dict[str, str]) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.patch(SETTINGS, body)).status_code == 422


async def test_settings_need_admin_settings_and_csrf(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{a.slug}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await p.client.get(SETTINGS)).status_code == 403
        assert (await p.patch(SETTINGS, {"region": "CA"})).status_code == 403
        assert (await p.post(ROTATE)).status_code == 403
    async with phone() as p:
        _as_admin(p, a)
        await p.csrf()
        assert (await p.client.patch(SETTINGS, json={"region": "CA"})).status_code == 403
        assert (await p.client.post(ROTATE)).status_code == 403
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as member:
        await member.join(a.slug, CODE)
        assert (await member.client.get(SETTINGS)).status_code == 401
        assert (await member.post(ROTATE)).status_code == 401


async def test_rotating_the_slug_retires_the_old_qr(two_households: Pair) -> None:
    a, b = two_households
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as inside, phone() as admin:
        assert (await inside.join(a.slug, CODE)).status_code == 200
        _as_admin(admin, a)
        resp = await admin.post(ROTATE)
        assert resp.status_code == 200
        new_slug = resp.json()["join_slug"]
        assert re.fullmatch(r"[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}", new_slug)
        assert new_slug != a.slug
        assert (await admin.client.get(SETTINGS)).json()["join_slug"] == new_slug
        # Phones already in keep working.
        assert (await inside.client.get("/api/v1/devices/me")).status_code == 200
    async with phone() as old_qr:
        assert (await old_qr.join(a.slug, CODE)).status_code == 400
    async with phone() as new_qr:
        assert (await new_qr.join(new_slug, CODE)).status_code == 200
    # Only household a's slug moved.
    async with phone() as p:
        _as_admin(p, b)
        assert (await p.client.get(SETTINGS)).json()["join_slug"] == b.slug
    assert await _audit(a, "household.join_slug_rotated") == [{}]


async def test_rotation_retries_a_colliding_slug(
    two_households: Pair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first candidate is household b's slug; the unique constraint forces a retry."""
    a, b = two_households
    from app.domain import join_slug

    candidates = iter([b.slug, "zzzz-zzzz-zzzz"])
    monkeypatch.setattr(join_slug, "generate", lambda: next(candidates))
    async with phone() as p:
        _as_admin(p, a)
        resp = await p.post(ROTATE)
        assert resp.status_code == 200
        assert resp.json()["join_slug"] == "zzzz-zzzz-zzzz"


async def test_settings_row_is_created_if_missing(two_households: Pair) -> None:
    a, _ = two_households
    async with household_session(a.household_id) as db:
        await db.execute(
            text("DELETE FROM settings WHERE household_id = :h"), {"h": a.household_id}
        )
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.client.get(SETTINGS)).json()["default_voting_method"] == "top3"
