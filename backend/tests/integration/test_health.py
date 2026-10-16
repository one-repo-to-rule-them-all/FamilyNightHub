"""Health and role posture against real Postgres + Redis (docker compose up -d db redis)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.core.database import AsyncSessionLocal
from app.main import app

pytestmark = pytest.mark.integration


async def test_health_ok_through_rls_path() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/health")
    assert resp.status_code == 200, resp.text
    assert resp.json()["database"] == "ok"
    assert resp.json()["redis"] == "ok"


async def test_app_role_cannot_bypass_rls() -> None:
    """ADR-0003: the runtime role must be ordinary, or every RLS policy is decorative."""
    async with AsyncSessionLocal() as session:
        row = (
            await session.execute(
                text(
                    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles "
                    "WHERE rolname = current_user"
                )
            )
        ).one()
    assert row.rolname == "fnh_app"
    assert row.rolsuper is False
    assert row.rolbypassrls is False


async def test_household_guc_is_transaction_scoped() -> None:
    """set_config(..., true) must not leak to the next transaction on a pooled connection."""
    async with AsyncSessionLocal() as session:
        async with session.begin():
            await session.execute(
                text("SELECT set_config('app.household_id', :h, true)"),
                {"h": "11111111-1111-1111-1111-111111111111"},
            )
        async with session.begin():
            leaked = await session.scalar(text("SELECT current_setting('app.household_id', true)"))
    assert leaked in (None, "")
