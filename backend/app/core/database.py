"""Async engine, session factory and the household RLS GUC (ADR-0003).

The app connects as `fnh_app`, an ordinary role without BYPASSRLS, so every
household-scoped table's FORCE ROW LEVEL SECURITY policy binds it. The household id is
set per transaction with `set_config('app.household_id', :hid, true)`: the function form
of `SET LOCAL`. Unlike `SET LOCAL` it accepts a bound parameter through asyncpg's
extended protocol, and it is transaction-scoped, so it is safe behind PgBouncer
transaction mode. Session-level `SET` is banned.
Pattern from OrderUp app/core/tenancy.py @ 2f86cd8.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)

log = structlog.get_logger()

_SET_HOUSEHOLD = text("SELECT set_config('app.household_id', :hid, true)")


async def apply_household_guc(session: AsyncSession, household_id: uuid.UUID) -> None:
    """Scope the current transaction to one household. Must run inside the transaction."""
    await session.execute(_SET_HOUSEHOLD, {"hid": str(household_id)})


@asynccontextmanager
async def household_session(household_id: uuid.UUID) -> AsyncIterator[AsyncSession]:
    """Open a session, begin a transaction and set the household GUC.

    Used by request dependencies, the worker (once per household it iterates) and tests.
    Commits on clean exit, rolls back on exception. Hooks queued with `after_commit` run
    once the commit has succeeded (live-update hints, ADR-0004); a rollback drops them.
    """
    async with AsyncSessionLocal() as session:
        async with session.begin():
            await apply_household_guc(session, household_id)
            yield session
        await _run_after_commit(session)


AfterCommit = Callable[[], Awaitable[None]]
_AFTER_COMMIT = "fnh_after_commit"


def after_commit(session: AsyncSession, hook: AfterCommit) -> None:
    """Run `hook` after this session's household transaction commits, in queue order."""
    session.info.setdefault(_AFTER_COMMIT, []).append(hook)


async def _run_after_commit(session: AsyncSession) -> None:
    hooks: list[AfterCommit] = session.info.pop(_AFTER_COMMIT, [])
    for hook in hooks:
        try:
            await hook()
        except Exception:  # noqa: BLE001 - the write is committed; a hook can't undo it
            log.warning("after_commit_hook_failed", exc_info=True)
