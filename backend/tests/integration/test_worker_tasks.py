"""Worker task bodies against real Postgres as fnh_app (06-background-worker.md).

The tasks are called directly with a hand-built ctx: no Redis, no ARQ loop. Every write
and read goes through `household_session`, so these also prove the worker works with RLS
on (it never sees another household's rows except through its own GUC).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import household_session
from app.workers import tasks
from app.workers.tasks import (
    HouseholdTaskError,
    auto_close_stale_sessions,
    for_each_household,
    list_household_ids,
    sweep_orphan_uploads,
)
from tests.integration.seed import SeededHousehold

pytestmark = pytest.mark.integration


class RecordingStore:
    def __init__(self, fail: bool = False) -> None:
        self.deleted: list[str] = []
        self.fail = fail

    async def delete_objects(self, keys: Sequence[str]) -> None:
        if self.fail:
            raise ConnectionError("storage unreachable")
        self.deleted.extend(keys)


async def _exec(scope: uuid.UUID, sql: str, **params: Any) -> None:
    async with household_session(scope) as s:
        await s.execute(text(sql), params)


async def _one(hid: uuid.UUID, sql: str, **params: Any) -> Any:
    async with household_session(hid) as s:
        return (await s.execute(text(sql), params)).one_or_none()


async def _add_session(hid: uuid.UUID, status: str, revealed_hours_ago: int | None) -> uuid.UUID:
    sid = uuid.uuid4()
    await _exec(
        hid,
        "INSERT INTO sessions (id, household_id, night_code_hash, status, revealed_at) "
        "VALUES (:id, :hid, :code, :status, "
        "CASE WHEN CAST(:ago AS int) IS NULL THEN NULL "
        "ELSE now() - make_interval(hours => CAST(:ago AS int)) END)",
        id=sid,
        hid=hid,
        code=f"nc{sid.hex}",
        status=status,
        ago=revealed_hours_ago,
    )
    return sid


async def _status(hid: uuid.UUID, sid: uuid.UUID) -> tuple[str, Any]:
    row = await _one(hid, "SELECT status, closed_at FROM sessions WHERE id = :id", id=sid)
    return row.status, row.closed_at


async def _audits(hid: uuid.UUID, sid: uuid.UUID) -> list[Any]:
    async with household_session(hid) as s:
        result = await s.execute(
            text(
                "SELECT action, actor_account_id, actor_device_id, data FROM audit_events "
                "WHERE target_id = :id"
            ),
            {"id": sid},
        )
        return list(result.all())


# --------------------------------------------------------------------------- #
# household iteration
# --------------------------------------------------------------------------- #


async def test_lists_households_through_the_adr_0009_resolver(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, b = two_households
    ids = await list_household_ids()
    assert {a.household_id, b.household_id} <= set(ids)


async def test_each_household_runs_in_its_own_rls_scope(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    """Inside the loop the worker sees exactly one household's rows: RLS stays on."""
    a, b = two_households
    seen: dict[uuid.UUID, set[uuid.UUID]] = {}

    async def visible(session: AsyncSession, hid: uuid.UUID) -> int:
        rows = await session.scalars(text("SELECT DISTINCT household_id FROM people"))
        seen[hid] = set(rows)
        return 0

    await for_each_household("probe", visible)
    assert seen[a.household_id] == {a.household_id}
    assert seen[b.household_id] == {b.household_id}


async def test_one_failing_household_does_not_stop_the_others(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, b = two_households
    done: list[uuid.UUID] = []

    async def work(session: AsyncSession, hid: uuid.UUID) -> int:
        if hid == a.household_id:
            raise RuntimeError("household a is broken")
        done.append(hid)
        return 1

    with pytest.raises(HouseholdTaskError) as excinfo:
        await for_each_household("probe", work)
    assert b.household_id in done
    # The message is persisted in failed_jobs: counts only, never household ids.
    assert str(a.household_id) not in str(excinfo.value)
    assert "1 of" in str(excinfo.value)


async def test_failing_household_is_reported_to_sentry_when_configured(
    two_households: tuple[SeededHousehold, SeededHousehold],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sentry_sdk

    a, _ = two_households
    captured: list[BaseException] = []
    monkeypatch.setattr(tasks.settings, "SENTRY_DSN", "https://key@example.invalid/1")
    monkeypatch.setattr(sentry_sdk, "capture_exception", captured.append)

    async def work(session: AsyncSession, hid: uuid.UUID) -> int:
        if hid == a.household_id:
            raise RuntimeError("boom")
        return 0

    with pytest.raises(HouseholdTaskError):
        await for_each_household("probe", work)
    assert [str(e) for e in captured] == ["boom"]


# --------------------------------------------------------------------------- #
# auto_close_stale_sessions
# --------------------------------------------------------------------------- #


async def test_stale_nights_close_with_an_audit_row(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, _ = two_households
    hid = a.household_id
    stale_tonight = await _add_session(hid, "tonight", revealed_hours_ago=25)
    # revealed -> tonight is lazy (03-backend.md): an untouched revealed night is stale too.
    stale_revealed = await _add_session(hid, "revealed", revealed_hours_ago=30)

    result = await auto_close_stale_sessions({})

    assert result["closed"] >= 2
    for sid in (stale_tonight, stale_revealed):
        status, closed_at = await _status(hid, sid)
        assert status == "closed"
        assert closed_at is not None
        audits = await _audits(hid, sid)
        assert len(audits) == 1
        assert audits[0].action == "session.auto_closed"
        assert audits[0].actor_account_id is None and audits[0].actor_device_id is None
        assert audits[0].data == {"reason": "stale", "after_hours": 24}


async def test_fresh_and_other_status_nights_are_left_alone(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, b = two_households
    fresh = await _add_session(a.household_id, "tonight", revealed_hours_ago=2)
    voting = await _add_session(a.household_id, "voting", revealed_hours_ago=None)
    other_stale = await _add_session(b.household_id, "tonight", revealed_hours_ago=48)

    await auto_close_stale_sessions({})

    assert (await _status(a.household_id, fresh))[0] == "tonight"
    assert (await _status(a.household_id, voting))[0] == "voting"
    assert await _audits(a.household_id, fresh) == []
    # The seeded draft night of household a is untouched.
    assert (await _status(a.household_id, a.ids["session"]))[0] == "draft"
    # Household b is processed in its own scope, and its audit row is its own.
    assert (await _status(b.household_id, other_stale))[0] == "closed"
    assert await _audits(a.household_id, other_stale) == []
    assert len(await _audits(b.household_id, other_stale)) == 1


async def test_auto_close_is_idempotent(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, _ = two_households
    sid = await _add_session(a.household_id, "tonight", revealed_hours_ago=25)
    await auto_close_stale_sessions({})
    await auto_close_stale_sessions({})
    assert len(await _audits(a.household_id, sid)) == 1


# --------------------------------------------------------------------------- #
# sweep_orphan_uploads
# --------------------------------------------------------------------------- #


async def _age_photo(hid: uuid.UUID, pid: uuid.UUID, hours: int, status: str = "pending") -> None:
    await _exec(
        hid,
        "UPDATE photos SET status = :status, "
        "created_at = now() - make_interval(hours => :hours) WHERE id = :id",
        status=status,
        hours=hours,
        id=pid,
    )


async def _photo_exists(hid: uuid.UUID, pid: uuid.UUID) -> bool:
    return await _one(hid, "SELECT 1 FROM photos WHERE id = :id", id=pid) is not None


async def _photo_keys(hid: uuid.UUID, pid: uuid.UUID) -> tuple[str, str]:
    row = await _one(hid, "SELECT object_key, thumb_key FROM photos WHERE id = :id", id=pid)
    return row.object_key, row.thumb_key


async def test_old_pending_uploads_are_swept_storage_first(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, b = two_households
    a_photo, b_photo = a.ids["photo"], b.ids["photo"]
    await _age_photo(a.household_id, a_photo, hours=25)
    keys = await _photo_keys(a.household_id, a_photo)
    store = RecordingStore()

    result = await sweep_orphan_uploads({"storage": store})

    assert result["swept"] >= 1
    assert not await _photo_exists(a.household_id, a_photo)
    assert set(keys) <= set(store.deleted)
    # Household b's pending photo is fresh: kept, and its objects untouched.
    assert await _photo_exists(b.household_id, b_photo)
    assert not set(await _photo_keys(b.household_id, b_photo)) & set(store.deleted)


async def test_ready_photos_and_fresh_uploads_are_never_swept(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, _ = two_households
    await _age_photo(a.household_id, a.ids["photo"], hours=72, status="ready")
    store = RecordingStore()
    await sweep_orphan_uploads({"storage": store})
    assert await _photo_exists(a.household_id, a.ids["photo"])
    assert not set(await _photo_keys(a.household_id, a.ids["photo"])) & set(store.deleted)


async def test_storage_failure_keeps_the_row_for_the_next_tick(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, _ = two_households
    await _age_photo(a.household_id, a.ids["photo"], hours=25)
    with pytest.raises(HouseholdTaskError):
        await sweep_orphan_uploads({"storage": RecordingStore(fail=True)})
    assert await _photo_exists(a.household_id, a.ids["photo"])


async def test_sweep_defaults_to_the_noop_store(
    two_households: tuple[SeededHousehold, SeededHousehold],
) -> None:
    a, _ = two_households
    await _age_photo(a.household_id, a.ids["photo"], hours=25)
    await sweep_orphan_uploads({})
    assert not await _photo_exists(a.household_id, a.ids["photo"])
