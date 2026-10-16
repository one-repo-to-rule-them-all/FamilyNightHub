"""Schema-level guards for ADR-0003 and ADR-0009 (07-cicd.md "isolation" job).

These read the live catalog after `alembic upgrade head`, so a future migration that adds a
household table without FORCE RLS, adds a global table without a decision, or widens the
pre-auth surface fails CI here.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.core.database import AsyncSessionLocal

pytestmark = pytest.mark.integration

# Tables that deliberately carry no household data and no RLS. Adding one is a reviewed
# decision: it becomes readable by fnh_app with no GUC.
GLOBAL_TABLES = {"alembic_version", "tmdb_cache", "failed_jobs", "backup_runs"}

RESOLVER_FUNCTIONS = {
    "auth_resolve_device",
    "auth_resolve_magic_link",
    "auth_resolve_account_by_email",
    "auth_resolve_household_by_slug",
    "worker_list_household_ids",
}


async def _rows(sql: str) -> list[dict[str, object]]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(text(sql))
        return [dict(r._mapping) for r in result]


async def test_every_household_table_forces_rls_with_isolation_policy() -> None:
    tables = await _rows(
        """
        SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
               EXISTS (SELECT 1 FROM pg_policy p
                       WHERE p.polrelid = c.oid AND p.polname = 'household_isolation') AS policy,
               EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname
                         AND col.column_name = 'household_id') AS scoped
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        """
    )
    scoped = [t for t in tables if t["scoped"] or t["table"] == "households"]
    assert len(scoped) == 16, sorted(str(t["table"]) for t in scoped)

    unprotected = [t["table"] for t in scoped if not (t["enabled"] and t["forced"] and t["policy"])]
    assert unprotected == [], f"household tables missing FORCE RLS + policy: {unprotected}"

    unscoped = {str(t["table"]) for t in tables} - {str(t["table"]) for t in scoped}
    assert unscoped == GLOBAL_TABLES, (
        f"new table without household_id: {unscoped - GLOBAL_TABLES}. Scope it, or add it to "
        "GLOBAL_TABLES if it holds no household data."
    )


async def test_app_role_has_no_access_to_alembic_version() -> None:
    [row] = await _rows(
        "SELECT has_table_privilege('fnh_app', 'alembic_version', 'SELECT, UPDATE') AS ok"
    )
    assert row["ok"] is False


async def test_pre_auth_surface_is_exactly_the_resolver_functions() -> None:
    """ADR-0009: definer functions are pinned by name, owner, search_path and grants."""
    fns = await _rows(
        """
        SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
               p.proconfig AS config,
               has_function_privilege('fnh_app', p.oid, 'EXECUTE') AS app_exec,
               EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee = 0) AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        """
    )
    assert {f["name"] for f in fns} == RESOLVER_FUNCTIONS
    for f in fns:
        assert f["owner"] == "fnh_resolver", f
        assert f["config"] == ["search_path=pg_catalog, public"], f
        assert f["app_exec"] is True, f
        assert f["public_exec"] is False, f


async def test_resolver_role_is_read_only_and_cannot_log_in() -> None:
    [role] = await _rows(
        "SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'fnh_resolver'"
    )
    assert role == {"rolcanlogin": False, "rolbypassrls": False, "rolsuper": False}

    writable = await _rows(
        """
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND has_table_privilege('fnh_resolver', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
        """
    )
    assert writable == []

    [membership] = await _rows(
        "SELECT pg_has_role('fnh_app', 'fnh_resolver', 'MEMBER') AS is_member"
    )
    assert membership["is_member"] is False


async def test_resolver_column_grants_are_narrow() -> None:
    """The resolver can read token hashes but not, say, device labels or account names."""
    [row] = await _rows(
        """
        SELECT has_column_privilege('fnh_resolver', 'devices', 'token_hash', 'SELECT') AS hash,
               has_column_privilege('fnh_resolver', 'devices', 'label', 'SELECT') AS label,
               has_column_privilege('fnh_resolver', 'accounts', 'display_name', 'SELECT') AS name,
               has_table_privilege('fnh_resolver', 'photos', 'SELECT') AS photos
        """
    )
    assert row == {"hash": True, "label": False, "name": False, "photos": False}
