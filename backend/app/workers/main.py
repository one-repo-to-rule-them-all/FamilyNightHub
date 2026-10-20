"""ARQ worker entry point (06-background-worker.md). Runs as the Fly app `fnh-worker` from
the same image as `fnh-api`.

    python -m app.workers.main
    arq app.workers.main.WorkerSettings

Copied from FieldPro backend/app/workers/main.py @ 0670961, keeping its pitfalls:
- No shared `ctx["db"]` session. ARQ runs up to `max_jobs` jobs concurrently, and one
  AsyncSession on one connection cannot serve two at once ("concurrent operations are not
  permitted"). Each task opens its own sessions (tasks.py).
- Dead letters are written from `after_job_end`, which runs after ARQ has stored the
  result, so `result_info()` can see the failure (`on_job_end` runs before). Any
  `success=False` is terminal: ARQ only retries on an explicit `Retry`.
- `run_worker` is synchronous. Never wrap it in `asyncio.run` (FieldPro crashed on every
  SIGINT from `fly secrets set` because of that).
- Health is a plain HTTP listener checked with curl, not a Python probe.
Differences from FieldPro: cron failures are recorded too (every task here is a cron, and
06 makes `failed_jobs` + Sentry the DLQ for all of them); `failed_jobs` never stores args
or kwargs; the health listener is stdlib asyncio rather than aiohttp.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, ClassVar, cast
from zoneinfo import ZoneInfo

import structlog
from arq import cron, run_worker
from arq.connections import RedisSettings
from arq.jobs import Job
from sqlalchemy import text

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.logging import configure_logging
from app.integrations.storage import NoopObjectStore, configured_storage
from app.workers.tasks import (
    auto_close_stale_sessions,
    purge_deleted_households,
    sweep_orphan_uploads,
)

if TYPE_CHECKING:
    from arq.typing import WorkerSettingsType

log = structlog.get_logger()

# 06: cron times are household-local. One household today, all in Central time.
CRON_TIMEZONE = ZoneInfo("America/Chicago")
# failed_jobs.error is free text; keep it short and to the exception's first line.
MAX_ERROR_CHARS = 500


def init_sentry() -> None:
    """No-op without SENTRY_DSN. No FastAPI integration: the worker is not an ASGI app."""
    if not settings.SENTRY_DSN:
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
        send_default_pii=False,
    )


# --------------------------------------------------------------------------- #
# /health listener
# --------------------------------------------------------------------------- #

_OK = (
    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n"
    b"Connection: close\r\n\r\n"
    b'{"status":"ok"}'
)
_NOT_FOUND = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


async def _handle_health(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Liveness only: it proves the event loop answers. It deliberately does not touch
    Postgres or Redis, so a database failover cannot put the worker into a restart loop
    (FieldPro). The API's /api/health covers the data plane."""
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=5)
        parts = request_line.split()
        ok = len(parts) >= 2 and parts[0] in (b"GET", b"HEAD") and parts[1] == b"/health"
        writer.write(_OK if ok else _NOT_FOUND)
        await writer.drain()
    except (TimeoutError, ConnectionError):
        pass
    finally:
        writer.close()


async def start_health_server(ctx: dict[str, Any], port: int) -> None:
    """Bind the listener. A bind failure is logged, not raised: a worker without /health
    still drains the queue, and the failing check makes the problem visible."""
    try:
        server = await asyncio.start_server(_handle_health, host="0.0.0.0", port=port)
    except OSError as exc:
        log.warning("worker_health_bind_failed", port=port, error=str(exc))
        return
    ctx["health_server"] = server
    log.info("worker_health_listening", port=server.sockets[0].getsockname()[1])


async def stop_health_server(ctx: dict[str, Any]) -> None:
    server: asyncio.Server | None = ctx.pop("health_server", None)
    if server is not None:
        server.close()
        await server.wait_closed()


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #


async def startup(ctx: dict[str, Any]) -> None:
    init_sentry()  # first, so a failure in the rest of startup is captured
    configure_logging()
    log.info("worker_startup", environment=settings.ENVIRONMENT)
    # The photos bucket (sweep deletes orphaned uploads); a no-op when storage is unset.
    ctx["storage"] = configured_storage() or NoopObjectStore()
    await start_health_server(ctx, settings.WORKER_HEALTH_PORT)


async def shutdown(ctx: dict[str, Any]) -> None:
    await stop_health_server(ctx)
    log.info("worker_shutdown")


# --------------------------------------------------------------------------- #
# Dead letters
# --------------------------------------------------------------------------- #


def summarize_error(exc: object) -> str:
    """Exception type plus the first line of its message, truncated. Never args/kwargs:
    they can carry household ids or names (FailedJob docstring)."""
    lines = str(exc).splitlines()
    first = lines[0] if lines else ""
    summary = f"{type(exc).__name__}: {first}" if first else type(exc).__name__
    return summary[:MAX_ERROR_CHARS]


async def record_failed_job(job_name: str, job_id: str, job_try: int, error: str) -> None:
    """Insert into the global `failed_jobs` table in a fresh session: the task's own
    session may have died with the failure."""
    async with AsyncSessionLocal() as session, session.begin():
        await session.execute(
            text(
                "INSERT INTO failed_jobs (job_name, job_id, job_try, error) "
                "VALUES (:name, :id, :try, :error)"
            ),
            {"name": job_name, "id": job_id, "try": job_try, "error": error},
        )


async def after_job_end(ctx: dict[str, Any]) -> None:
    """Record a terminally failed job in `failed_jobs` and Sentry. Each step is isolated:
    a Sentry outage must not lose the DLQ row and vice versa. Never re-raises (the job is
    already finished; raising here only kills the worker loop)."""
    job_id = ctx.get("job_id")
    redis = ctx.get("redis")
    if not job_id or redis is None:
        return
    try:
        result_info = await Job(job_id, redis).result_info()
    except Exception:
        log.warning("after_job_end_result_lookup_failed", job_id=job_id, exc_info=True)
        return
    if result_info is None or result_info.success:
        return

    job_name = result_info.function or "<unknown>"
    job_try = int(ctx.get("job_try") or result_info.job_try or 0)
    try:
        await record_failed_job(job_name, str(job_id), job_try, summarize_error(result_info.result))
        log.warning("failed_job_recorded", job_name=job_name, job_id=job_id, job_try=job_try)
    except Exception:
        log.exception("failed_job_record_failed", job_name=job_name, job_id=job_id)

    if settings.SENTRY_DSN:
        try:
            import sentry_sdk

            with sentry_sdk.new_scope() as scope:
                scope.set_tag("task_name", job_name)
                scope.set_tag("job_id", str(job_id))
                scope.set_context("arq", {"job_try": job_try})
                sentry_sdk.capture_exception(result_info.result)
        except Exception:
            log.warning("after_job_end_sentry_failed", job_id=job_id, exc_info=True)


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


class WorkerSettings:
    """Discovered by `arq`. ARQ shares Upstash DB 0 with SSE under its `arq:` prefix (06)."""

    functions: ClassVar[list[Any]] = [
        auto_close_stale_sessions,
        sweep_orphan_uploads,
        purge_deleted_households,
    ]

    # Minutes are staggered so the hourly jobs never share a tick. unique=True keeps a
    # second worker replica (none planned) from running the same tick twice.
    cron_jobs: ClassVar[list[Any]] = [
        cron(auto_close_stale_sessions, minute=10, unique=True),
        cron(sweep_orphan_uploads, minute=40, unique=True),
        cron(purge_deleted_households, minute=25, unique=True),
    ]
    timezone = CRON_TIMEZONE

    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    max_jobs = 10
    job_timeout = settings.WORKER_JOB_TIMEOUT_SECONDS
    keep_result = settings.WORKER_KEEP_RESULT_SECONDS
    # ARQ logs job args at INFO and results here; keep results out of the logs.
    log_results = False

    on_startup = startup
    on_shutdown = shutdown
    after_job_end = after_job_end


def main() -> None:
    """Blocking. Installs SIGINT/SIGTERM handlers and drains in-flight jobs on shutdown."""
    # ARQ logs through stdlib logging, which `run_worker` (unlike the arq CLI) leaves
    # unconfigured. WARNING, not INFO: at INFO ARQ prints every job's args.
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    run_worker(cast("WorkerSettingsType", WorkerSettings))


if __name__ == "__main__":
    main()
