"""Deleting a whole household (ADR-0017 §4): scheduled with the admin's password and the
household's name, cancellable by any admin, then erased by the worker (bucket first)."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest
from httpx import Response
from sqlalchemy import text

from app.core import hashing
from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.workers.tasks import HouseholdTaskError, purge_deleted_households
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.test_auth import Outbox, outbox

pytestmark = pytest.mark.integration

__all__ = ["outbox"]

Pair = tuple[SeededHousehold, SeededHousehold]
DELETION = "/api/v1/admin/household/deletion"
PASSWORD = "a long and careful password"


class RecordingStore:
    def __init__(self, fail: bool = False) -> None:
        self.deleted: list[str] = []
        self.fail = fail

    async def delete_objects(self, keys: Sequence[str]) -> None:
        if self.fail:
            raise ConnectionError("storage unreachable")
        self.deleted.extend(keys)


async def _with_password(house: SeededHousehold) -> None:
    async with household_session(house.household_id) as db:
        await db.execute(
            text("UPDATE accounts SET password_hash = :h WHERE id = :a"),
            {"h": await hashing.hash_password(PASSWORD), "a": house.ids["account"]},
        )


async def _request(p: Phone, password: str = PASSWORD, name: str = "family A") -> Response:
    return await p.post(DELETION, {"password": password, "household_name": name})


async def _cancel(p: Phone) -> Response:
    return await p.client.delete(DELETION, headers={CSRF_HEADER: await p.csrf()})


async def _households(house: SeededHousehold) -> int:
    async with household_session(house.household_id) as db:
        count: int = await db.scalar(text("SELECT count(*) FROM households"))
    return count


async def _make_due(house: SeededHousehold, due: bool = True) -> None:
    when = datetime.now(UTC) + (timedelta(minutes=-1) if due else timedelta(days=3))
    async with household_session(house.household_id) as db:
        await db.execute(
            text("UPDATE households SET deletion_requested_at = now(), delete_after = :d"),
            {"d": when},
        )


async def test_admin_schedules_and_another_admin_cancels(
    two_households: Pair, outbox: Outbox
) -> None:
    a, _ = two_households
    await _with_password(a)
    second = await add_account(a.household_id, "admin", f"two.{uuid.uuid4().hex[:8]}@ex.test")
    async with phone() as p:
        p.sign_in_as(a.ids["account"], a.household_id)
        assert (await _request(p, password="not my password")).status_code == 403
        wrong_name = await _request(p, name="Family B")
        assert wrong_name.status_code == 422

        scheduled = await _request(p)
        assert scheduled.status_code == 200, scheduled.text
        body = scheduled.json()
        assert body["household_name"] == "Family a"
        assert body["requested_by"] == "Host"
        delete_after = datetime.fromisoformat(body["delete_after"])
        assert timedelta(days=6, hours=23) < delete_after - datetime.now(UTC) <= timedelta(days=7)
        assert (await _request(p)).status_code == 409

    # Every admin hears about it.
    assert len(outbox.sent) == 2
    assert all("will be deleted" in m.subject for m in outbox.sent)
    assert all("/admin/settings#data" in m.text for m in outbox.sent)

    async with phone() as p:
        p.sign_in_as(second, a.household_id)
        assert (await p.client.get(DELETION)).json()["delete_after"] is not None
        cancelled = await _cancel(p)
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["delete_after"] is None
        assert (await _cancel(p)).status_code == 409
    assert sum("will not be deleted" in m.subject for m in outbox.sent) == 2

    async with household_session(a.household_id) as db:
        actions = list(
            await db.scalars(
                text(
                    "SELECT action FROM audit_events WHERE action LIKE 'household.deletion%' "
                    "ORDER BY created_at"
                )
            )
        )
    assert actions == ["household.deletion_requested", "household.deletion_cancelled"]


async def test_hosts_cannot_schedule_or_cancel(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@ex.test")
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await _request(p)).status_code == 403
        assert (await _cancel(p)).status_code == 403


async def test_worker_erases_a_due_household_bucket_first(two_households: Pair) -> None:
    a, b = two_households
    await _make_due(a)
    await _make_due(b, due=False)
    async with household_session(a.household_id) as db:
        photo = (await db.execute(text("SELECT object_key, thumb_key FROM photos"))).one()

    store = RecordingStore()
    result = await purge_deleted_households({"storage": store})

    assert result["photos"] >= 1
    assert {photo.object_key, photo.thumb_key} <= set(store.deleted)
    assert await _households(a) == 0
    async with household_session(a.household_id) as db:
        for table in ("people", "photos", "household_consents", "audit_events"):
            assert await db.scalar(text(f"SELECT count(*) FROM {table}")) == 0, table
    # Not due yet: untouched.
    assert await _households(b) == 1


async def test_a_storage_outage_keeps_the_household_for_the_next_tick(
    two_households: Pair,
) -> None:
    a, _ = two_households
    await _make_due(a)
    with pytest.raises(HouseholdTaskError):
        await purge_deleted_households({"storage": RecordingStore(fail=True)})
    assert await _households(a) == 1
