"""Removing a person, and starting a household over (issue #94)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.database import household_session
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.storage_doubles import FakeStorage, storage

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
PEOPLE = "/api/v1/admin/people"
FRESH = "/api/v1/admin/start-fresh"
OWNED = ("ballot_ranks", "ratings", "photos", "photo_reactions", "device_people")


@pytest.fixture
def fake() -> Iterator[FakeStorage]:
    bucket = FakeStorage()
    with storage(bucket):
        yield bucket


async def _sql(house: SeededHousehold, sql: str, **params: Any) -> list[Any]:
    async with household_session(house.household_id) as db:
        result: Any = await db.execute(text(sql), params)
        return list(result.all()) if result.returns_rows else []


async def _count(house: SeededHousehold, table: str) -> int:
    return int((await _sql(house, f"SELECT count(*) AS n FROM {table}"))[0].n)


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


async def _delete(p: Phone, person: uuid.UUID) -> Response:
    return await p.client.delete(f"{PEOPLE}/{person}", headers={"X-FNH-CSRF": await p.csrf()})


async def test_remove_deletes_the_person_and_everything_theirs(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, b = two_households
    kid = a.ids["person"]
    photo_keys = [r.object_key for r in await _sql(a, "SELECT object_key FROM photos")]
    async with phone() as p:
        _as_admin(p, a)
        preview = (await p.client.get(f"{PEOPLE}/{kid}/removal")).json()
        assert preview == {
            "nights_voted": 1,
            "ratings": 1,
            "photos": 1,
            "reactions": 1,
            "phones": 1,
        }
        resp = await _delete(p, kid)
        assert resp.status_code == 200, resp.text
        assert resp.json() == preview
        assert (await p.client.get(f"{PEOPLE}/{kid}/removal")).status_code == 404
    assert await _sql(a, "SELECT id FROM people WHERE id = :p", p=kid) == []
    for table in OWNED:
        assert await _count(a, table) == 0, table
    # The night itself stays; the photo is tombstoned and its objects deleted.
    assert await _count(a, "sessions") == 1
    assert set(photo_keys) <= set(fake.deleted)
    audit = await _sql(a, "SELECT data FROM audit_events WHERE action = 'person.removed'")
    assert len(audit) == 1 and audit[0].data["photos"] == 1
    # The other household is untouched.
    for table in OWNED:
        assert await _count(b, table) >= 1, table


async def test_remove_needs_photo_storage_only_when_they_shared_photos(
    two_households: Pair,
) -> None:
    a, _ = two_households
    kid = a.ids["person"]
    with storage(None):
        async with phone() as p:
            _as_admin(p, a)
            resp = await _delete(p, kid)
            assert resp.status_code == 503, resp.text
            # Rolled back: nothing of theirs went.
            assert await _count(a, "ballot_ranks") == 1
            fresh = await p.post(
                PEOPLE, {"name": "Typo Guest", "avatar_emoji": "🐙", "color": "#3366cc"}
            )
            new_id = uuid.UUID(fresh.json()["id"])
            assert (await _delete(p, new_id)).status_code == 200


async def test_removing_someone_from_another_household_is_404(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, b = two_households
    async with phone() as p:
        _as_admin(p, a)
        assert (await _delete(p, b.ids["person"])).status_code == 404
    assert await _count(b, "people") >= 1


async def test_hosts_cannot_remove_people_or_start_fresh(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{a.slug}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await _delete(p, a.ids["person"])).status_code == 403
        assert (await p.post(FRESH, {"confirm_name": "x"})).status_code == 403
    assert await _count(a, "people") >= 1


async def test_start_fresh_needs_the_family_name_then_clears_people_phones_and_nights(
    two_households: Pair, fake: FakeStorage
) -> None:
    a, b = two_households
    name = (await _sql(a, "SELECT name FROM households"))[0].name
    movies_before = await _count(a, "movies")
    async with phone() as p:
        _as_admin(p, a)
        wrong = await p.post(FRESH, {"confirm_name": "not the family"})
        assert wrong.status_code == 422
        assert await _count(a, "people") >= 1
        resp = await p.post(FRESH, {"confirm_name": f"  {name.upper()} "})
        assert resp.status_code == 200, resp.text
        assert resp.json()["people"] >= 1 and resp.json()["nights"] >= 1
    for table in ("people", "devices", "sessions", "options", *OWNED, "session_attendance"):
        assert await _count(a, table) == 0, table
    # Kept: the household, its accounts, settings and library.
    assert await _count(a, "households") == 1
    assert await _count(a, "accounts") >= 1
    assert await _count(a, "settings") == 1
    assert await _count(a, "movies") == movies_before
    audit = await _sql(a, "SELECT 1 FROM audit_events WHERE action = 'household.started_fresh'")
    assert len(audit) == 1
    for table in ("people", "devices", "sessions"):
        assert await _count(b, table) >= 1, table
