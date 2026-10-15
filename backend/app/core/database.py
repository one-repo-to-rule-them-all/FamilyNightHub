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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)

_SET_HOUSEHOLD = text("SELECT set_config('app.household_id', :hid, true)")


async def apply_household_guc(session: AsyncSession, household_id: uuid.UUID) -> None:
    """Scope the current transaction to one household. Must run inside the transaction."""
    await session.execute(_SET_HOUSEHOLD, {"hid": str(household_id)})


@asynccontextmanager
async def household_session(household_id: uuid.UUID) -> AsyncIterator[AsyncSession]:
    """Open a session, begin a transaction and set the household GUC.

    Used by request dependencies, the worker (once per household it iterates) and tests.
    Commits on clean exit, rolls back on exception.
    """
    async with AsyncSessionLocal() as session, session.begin():
        await apply_household_guc(session, household_id)
        yield session
