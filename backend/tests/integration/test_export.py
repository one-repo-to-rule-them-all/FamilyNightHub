"""Household export (ADR-0017 §4): every household table and every photo original, no
credential hashes, nothing from another household."""

from __future__ import annotations

import io
import json
import uuid
import zipfile

import pytest
from sqlalchemy import text

from app.core.database import AsyncSessionLocal, household_session
from app.services.export_service import NOT_EXPORTED, SECRET_COLUMNS, TABLES
from tests.integration.phones import add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.storage_doubles import FakeStorage, storage

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
EXPORT = "/api/v1/admin/export"
JPEG = b"\xff\xd8\xff\xe0fake-original"


async def _ready_photo(house: SeededHousehold) -> str:
    async with household_session(house.household_id) as db:
        key: str = (
            await db.execute(
                text("UPDATE photos SET status = 'ready' WHERE id = :p RETURNING object_key"),
                {"p": house.ids["photo"]},
            )
        ).scalar_one()
    return key


async def test_every_household_table_is_exported_or_deliberately_not() -> None:
    async with AsyncSessionLocal() as session:
        scoped = set(
            await session.scalars(
                text(
                    "SELECT table_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND column_name = 'household_id'"
                )
            )
        )
    assert set(TABLES) | NOT_EXPORTED == scoped | {"households"}
    assert not set(TABLES) & NOT_EXPORTED


async def test_admin_downloads_tables_and_originals_of_their_household_only(
    two_households: Pair,
) -> None:
    a, b = two_households
    key = await _ready_photo(a)
    await _ready_photo(b)
    bucket = FakeStorage()
    bucket.put(key, data=JPEG)

    with storage(bucket):
        async with phone() as p:
            p.sign_in_as(a.ids["account"], a.household_id)
            resp = await p.client.get(EXPORT)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    assert resp.headers["content-disposition"].startswith('attachment; filename="family-night-')

    archive = zipfile.ZipFile(io.BytesIO(resp.content))
    names = set(archive.namelist())
    photo_path = f"photos/{a.ids['session']}/{a.ids['photo']}.jpg"
    assert names == {"README.txt", photo_path, *(f"tables/{t}.json" for t in TABLES)}
    assert archive.read(photo_path) == JPEG

    tables = {t: json.loads(archive.read(f"tables/{t}.json")) for t in TABLES}
    assert tables["households"][0]["name"] == "Family a"
    assert [p["id"] for p in tables["people"]] == [str(a.ids["person"])]
    for table, rows in tables.items():
        for row in rows:
            assert not SECRET_COLUMNS & set(row), table
            if "household_id" in row:
                assert row["household_id"] == str(a.household_id), table
    everything = b"".join(archive.read(n) for n in names)
    assert str(b.household_id).encode() not in everything

    async with household_session(a.household_id) as db:
        audited = await db.scalar(
            text("SELECT data FROM audit_events WHERE action = 'household.exported'")
        )
    assert audited == {"photos": 1}


async def test_a_photo_missing_from_the_bucket_is_listed_not_fatal(two_households: Pair) -> None:
    a, _ = two_households
    await _ready_photo(a)
    with storage(FakeStorage()):
        async with phone() as p:
            p.sign_in_as(a.ids["account"], a.household_id)
            resp = await p.client.get(EXPORT)
    assert resp.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(resp.content))
    missing = archive.read("MISSING.txt").decode()
    assert f"photos/{a.ids['session']}/{a.ids['photo']}.jpg" in missing


async def test_hosts_cannot_export(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@example.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await p.client.get(EXPORT)).status_code == 403
