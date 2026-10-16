"""`python -m app.cli bootstrap`: the only way the first household and admin come to exist."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.cli import BootstrapError, bootstrap, main
from app.core.database import household_session

pytestmark = pytest.mark.integration


def _unique() -> str:
    return uuid.uuid4().hex[:10]


async def _cleanup(household_id: uuid.UUID) -> None:
    async with household_session(household_id) as db:
        await db.execute(text("DELETE FROM households WHERE id = :h"), {"h": household_id})


async def test_bootstrap_creates_household_settings_and_admin() -> None:
    tag = _unique()
    result = await bootstrap("The Test Family", f"test-{tag}", f"Admin.{tag}@Example.test", "Pat")
    try:
        assert result.join_url.endswith(f"/j/test-{tag}")
        async with household_session(result.household_id) as db:
            row = (
                await db.execute(
                    text(
                        "SELECT h.name, a.role, a.email, "
                        "(SELECT count(*) FROM settings) AS settings "
                        "FROM households h JOIN accounts a ON a.household_id = h.id"
                    )
                )
            ).one()
        assert (row.name, row.role, row.settings) == ("The Test Family", "admin", 1)
        # The new admin is reachable by the pre-auth resolver, i.e. can request a link.
        async with household_session(uuid.UUID(int=0)) as db:
            found = await db.scalar(
                text("SELECT account_id FROM auth_resolve_account_by_email(:e)"),
                {"e": f"admin.{tag}@example.test"},
            )
        assert found == result.account_id
    finally:
        await _cleanup(result.household_id)


async def test_bootstrap_refuses_duplicates() -> None:
    tag = _unique()
    first = await bootstrap("One", f"dup-{tag}", f"dup.{tag}@example.test", "A")
    try:
        with pytest.raises(BootstrapError, match="already taken"):
            await bootstrap("Two", f"dup-{tag}", f"other.{tag}@example.test", "B")
        with pytest.raises(BootstrapError, match="already has an account"):
            await bootstrap("Two", f"dup2-{tag}", f"DUP.{tag}@example.test", "B")
    finally:
        await _cleanup(first.household_id)


@pytest.mark.parametrize(
    ("household", "slug", "email", "name", "message"),
    [
        ("X", "Bad Slug", "a@b.co", "N", "slug"),
        ("X", "ab", "a@b.co", "N", "slug"),
        ("X", "-dash-", "a@b.co", "N", "slug"),
        ("X", "fine-slug", "not-an-email", "N", "email"),
        (" ", "fine-slug", "a@b.co", "N", "required"),
    ],
)
async def test_bootstrap_validates_input(
    household: str, slug: str, email: str, name: str, message: str
) -> None:
    with pytest.raises(BootstrapError, match=message):
        await bootstrap(household, slug, email, name)


def test_main_reports_errors_with_exit_code(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(
        ["bootstrap", "--household", "X", "--slug", "Bad Slug", "--email", "a@b.co", "--name", "N"]
    )
    assert code == 1
    assert "error: slug" in capsys.readouterr().err
