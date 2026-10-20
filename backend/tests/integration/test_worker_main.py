"""Worker process wiring: dead-letter capture, /health listener, settings.

The DLQ tests run a real ARQ worker in burst mode against Redis (own queue name, so a
running dev worker never steals the job), then read `failed_jobs` as fnh_app.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from arq import Worker
from arq.connections import ArqRedis, RedisSettings, create_pool
from sqlalchemy import text

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.integrations.storage import NoopObjectStore
from app.workers import main as worker_main
from app.workers.main import (
    CRON_TIMEZONE,
    MAX_ERROR_CHARS,
    WorkerSettings,
    after_job_end,
    shutdown,
    start_health_server,
    startup,
    stop_health_server,
    summarize_error,
)

pytestmark = pytest.mark.integration

ARG_SENTINEL = "Grandma-Rosa-secret-arg-7f3e"


async def failing_job(ctx: dict[str, Any], person_name: str, *, household_hint: str) -> None:
    raise ValueError("projector exploded\nsecond line with detail")


async def passing_job(ctx: dict[str, Any], person_name: str) -> str:
    return "ok"


async def _run_one(function: Any, *args: Any, **kwargs: Any) -> str:
    """Enqueue one job on a private queue and drain it with a burst worker."""
    queue = f"arq:test:{uuid.uuid4().hex}"
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    pool: ArqRedis = await create_pool(redis_settings)
    try:
        job = await pool.enqueue_job(function.__name__, *args, _queue_name=queue, **kwargs)
        assert job is not None
        worker = Worker(
            functions=[function],
            queue_name=queue,
            redis_pool=pool,
            burst=True,
            handle_signals=False,
            poll_delay=0,
            max_tries=1,
            keep_result=60,
            after_job_end=after_job_end,
        )
        # Not worker.close(): it signals SIGUSR1, which Windows lacks. The pool is ours.
        await worker.main()
        return job.job_id
    finally:
        await pool.aclose()


async def _failed_rows(job_id: str) -> list[Any]:
    async with AsyncSessionLocal() as session:
        rows = await session.execute(
            text("SELECT * FROM failed_jobs WHERE job_id = :id"), {"id": job_id}
        )
        return list(rows.all())


async def _cleanup(job_id: str) -> None:
    async with AsyncSessionLocal() as session, session.begin():
        await session.execute(text("DELETE FROM failed_jobs WHERE job_id = :id"), {"id": job_id})


# --------------------------------------------------------------------------- #
# Dead letters
# --------------------------------------------------------------------------- #


async def test_failed_job_lands_in_failed_jobs_without_args() -> None:
    job_id = await _run_one(failing_job, ARG_SENTINEL, household_hint=ARG_SENTINEL)
    try:
        rows = await _failed_rows(job_id)
        assert len(rows) == 1
        row = rows[0]
        assert row.job_name == "failing_job"
        assert row.job_try == 1
        assert row.error == "ValueError: projector exploded"
        # Neither positional nor keyword args are persisted anywhere in the row.
        assert ARG_SENTINEL not in " ".join(str(v) for v in row)
    finally:
        await _cleanup(job_id)


async def test_successful_job_writes_no_dead_letter() -> None:
    job_id = await _run_one(passing_job, ARG_SENTINEL)
    assert await _failed_rows(job_id) == []


async def test_failure_is_sent_to_sentry_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    import sentry_sdk

    captured: list[BaseException] = []
    monkeypatch.setattr(worker_main.settings, "SENTRY_DSN", "https://key@example.invalid/1")
    monkeypatch.setattr(sentry_sdk, "capture_exception", captured.append)
    job_id = await _run_one(failing_job, "x", household_hint="y")
    try:
        assert len(captured) == 1
        assert isinstance(captured[0], ValueError)
        assert len(await _failed_rows(job_id)) == 1
    finally:
        await _cleanup(job_id)


async def test_after_job_end_ignores_missing_context_and_unknown_jobs() -> None:
    await after_job_end({})
    pool = await create_pool(RedisSettings.from_dsn(settings.REDIS_URL))
    try:
        # No stored result for this id: nothing to record.
        await after_job_end({"job_id": f"missing-{uuid.uuid4().hex}", "redis": pool})
    finally:
        await pool.aclose()


async def test_after_job_end_survives_a_broken_redis() -> None:
    class BrokenRedis:
        async def get(self, *_: Any) -> None:
            raise ConnectionError("redis down")

    await after_job_end({"job_id": "j-1", "redis": BrokenRedis()})


async def test_dlq_write_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(*_: Any) -> None:
        raise ConnectionError("db down")

    monkeypatch.setattr(worker_main, "record_failed_job", broken)
    job_id = await _run_one(failing_job, "x", household_hint="y")
    assert await _failed_rows(job_id) == []


def test_summarize_error_keeps_type_and_first_line_only() -> None:
    assert summarize_error(RuntimeError("a\nb")) == "RuntimeError: a"
    assert summarize_error(RuntimeError()) == "RuntimeError"
    assert len(summarize_error(RuntimeError("x" * 5000))) == MAX_ERROR_CHARS


# --------------------------------------------------------------------------- #
# /health listener and lifecycle
# --------------------------------------------------------------------------- #


async def _http(port: int, request_line: bytes) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(request_line + b"\r\nHost: x\r\n\r\n")
    await writer.drain()
    data = await reader.read()
    writer.close()
    return data


async def test_health_listener_answers_get_health_only() -> None:
    ctx: dict[str, Any] = {}
    await start_health_server(ctx, port=0)
    port = ctx["health_server"].sockets[0].getsockname()[1]
    try:
        ok = await _http(port, b"GET /health HTTP/1.1")
        assert ok.startswith(b"HTTP/1.1 200 OK")
        assert ok.endswith(b'{"status":"ok"}')
        assert (await _http(port, b"GET /other HTTP/1.1")).startswith(b"HTTP/1.1 404")
        assert (await _http(port, b"POST /health HTTP/1.1")).startswith(b"HTTP/1.1 404")
    finally:
        await stop_health_server(ctx)
    assert "health_server" not in ctx
    await stop_health_server(ctx)  # idempotent


async def test_health_bind_failure_does_not_crash_the_worker() -> None:
    first: dict[str, Any] = {}
    await start_health_server(first, port=0)
    port = first["health_server"].sockets[0].getsockname()[1]
    try:
        second: dict[str, Any] = {}
        await start_health_server(second, port=port)
        assert "health_server" not in second
    finally:
        await stop_health_server(first)


async def test_startup_and_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker_main.settings, "WORKER_HEALTH_PORT", 0)
    ctx: dict[str, Any] = {}
    await startup(ctx)
    try:
        assert isinstance(ctx["storage"], NoopObjectStore)
        assert "health_server" in ctx
    finally:
        await shutdown(ctx)
    assert "health_server" not in ctx


def test_worker_settings_registers_only_built_tasks_on_central_time() -> None:
    names = {f.__name__ for f in WorkerSettings.functions}
    assert names == {
        "auto_close_stale_sessions",
        "sweep_orphan_uploads",
        "purge_deleted_households",  # ADR-0017 §4
    }
    assert {c.name for c in WorkerSettings.cron_jobs} == {
        "cron:auto_close_stale_sessions",
        "cron:sweep_orphan_uploads",
        "cron:purge_deleted_households",
    }
    assert all(c.unique for c in WorkerSettings.cron_jobs)
    assert str(WorkerSettings.timezone) == "America/Chicago"
    assert CRON_TIMEZONE.key == "America/Chicago"
    assert WorkerSettings.after_job_end is after_job_end
