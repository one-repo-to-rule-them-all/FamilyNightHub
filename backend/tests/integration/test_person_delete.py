"""Deleting a person (ADR-0017 §4): every row that names them goes, photos included, and the
bucket objects with them; a storage outage rolls the whole delete back."""

from __future__ import annotations

import uuid

import pytest
from httpx import Response
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.storage_doubles import DownStorage, FakeStorage, storage

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
PEOPLE = "/api/v1/admin/people"
NAMED = (
    "photos",
    "photo_reactions",
    "ballot_ranks",
    "ratings",
    "session_attendance",
    "device_people",
    "pin_reset_requests",
)


async def _delete(p: Phone, person_id: uuid.UUID) -> Response:
    return await p.client.delete(f"{PEOPLE}/{person_id}", headers={CSRF_HEADER: await p.csrf()})


async def _counts(house: SeededHousehold, person_id: uuid.UUID) -> dict[str, int]:
    async with household_session(house.household_id) as db:
        counts = {
            table: await db.scalar(
                text(f"SELECT count(*) FROM {table} WHERE person_id = :p"), {"p": person_id}
            )
            for table in NAMED
        }
        counts["people"] = await db.scalar(
            text("SELECT count(*) FROM people WHERE id = :p OR merged_into_id = :p"),
            {"p": person_id},
        )
    return counts


async def _photo_keys(house: SeededHousehold) -> list[str]:
    async with household_session(house.household_id) as db:
        row = (
            await db.execute(
                text("SELECT object_key, thumb_key FROM photos WHERE id = :p"),
                {"p": house.ids["photo"]},
            )
        ).one()
    return [row.object_key, row.thumb_key]


async def _merge_guest_into(house: SeededHousehold, person_id: uuid.UUID) -> uuid.UUID:
    async with household_session(house.household_id) as db:
        guest: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color, is_guest, "
                    "merged_into_id) VALUES (:h, 'Old guest', '🙂', '#3b82f6', true, :p) "
                    "RETURNING id"
                ),
                {"h": house.household_id, "p": person_id},
            )
        ).scalar_one()
    return guest


async def test_admin_erases_a_person_and_everything_that_names_them(two_households: Pair) -> None:
    a, b = two_households
    person = a.ids["person"]
    merged = await _merge_guest_into(a, person)
    keys = await _photo_keys(a)
    bucket = FakeStorage()
    for key in keys:
        bucket.put(key)

    with storage(bucket):
        async with phone() as p:
            p.sign_in_as(a.ids["account"], a.household_id)
            resp = await _delete(p, person)
            assert resp.status_code == 200, resp.text
            assert resp.json() == {
                "person_id": str(person),
                "photos": 1,
                "ballot_ranks": 1,
                "ratings": 1,
            }
            # Gone from the household's lists, and a second delete is a plain 404.
            assert (await _delete(p, person)).status_code == 404

    assert await _counts(a, person) == dict.fromkeys((*NAMED, "people"), 0)
    assert sorted(bucket.deleted) == sorted(keys)
    assert bucket.objects == {}

    async with household_session(a.household_id) as db:
        tombstoned = await db.scalar(
            text("SELECT count(*) FROM photo_deletions WHERE photo_id = :p"),
            {"p": a.ids["photo"]},
        )
        audit = (
            await db.execute(
                text("SELECT action, data FROM audit_events WHERE target_id = :p ORDER BY action"),
                {"p": person},
            )
        ).all()
        merged_gone = await db.scalar(
            text("SELECT count(*) FROM people WHERE id = :m"), {"m": merged}
        )
    assert tombstoned == 1
    assert merged_gone == 0
    assert [(r.action, r.data) for r in audit] == [
        ("person.deleted", {"photos": 1, "ballot_ranks": 1, "ratings": 1, "merged": 1})
    ]

    # The other household's person is untouched.
    assert (await _counts(b, b.ids["person"]))["people"] == 1


async def test_storage_outage_rolls_the_whole_delete_back(two_households: Pair) -> None:
    a, _ = two_households
    before = await _counts(a, a.ids["person"])
    with storage(DownStorage()):
        async with phone() as p:
            p.sign_in_as(a.ids["account"], a.household_id)
            resp = await _delete(p, a.ids["person"])
    assert resp.status_code == 503
    assert await _counts(a, a.ids["person"]) == before


async def test_only_admins_delete_and_only_in_their_household(two_households: Pair) -> None:
    a, b = two_households
    host = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@example.test")
    with storage(FakeStorage()):
        async with phone() as p:
            p.sign_in_as(host, a.household_id)
            assert (await _delete(p, a.ids["person"])).status_code == 403
            p.sign_in_as(a.ids["account"], a.household_id)
            assert (await _delete(p, b.ids["person"])).status_code == 404
    assert (await _counts(b, b.ids["person"]))["people"] == 1
