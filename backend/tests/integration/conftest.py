"""Integration fixtures: real Postgres + Redis from docker compose (or CI service containers).

Migrations run once per session as the owner role. Every seed and assertion then runs as
`fnh_app` through the normal GUC path, so these tests exercise the same RLS the API does
and never depend on the owner being a superuser.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app.core.database import household_session
from tests.integration.seed import SeededHousehold, seed_household

BACKEND_DIR = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    command.upgrade(cfg, "head")


async def _delete_household(household_id: uuid.UUID) -> None:
    async with household_session(household_id) as session:
        await session.execute(text("DELETE FROM households WHERE id = :h"), {"h": household_id})


@pytest.fixture
async def two_households() -> AsyncIterator[tuple[SeededHousehold, SeededHousehold]]:
    """Two fully seeded households (a row in every household-scoped table), removed after."""
    a = await seed_household("a")
    b = await seed_household("b")
    try:
        yield a, b
    finally:
        await _delete_household(a.household_id)
        await _delete_household(b.household_id)
