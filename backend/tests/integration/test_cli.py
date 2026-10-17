"""`python -m app.cli bootstrap`: the only way the first household and admin come to exist."""

from __future__ import annotations

import io
import uuid

import pytest
from sqlalchemy import text

from app.cli import BootstrapError, bootstrap, main, read_password, set_password
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


# --- ADR-0014: usernames and passwords from the CLI ---------------------------------


async def test_bootstrap_takes_an_optional_username() -> None:
    tag = _unique()
    result = await bootstrap("U", f"user-{tag}", f"user.{tag}@example.test", "U", f"Admin.{tag}")
    try:
        with pytest.raises(BootstrapError, match="username"):
            await bootstrap("V", f"user2-{tag}", f"user2.{tag}@example.test", "V", f"admin.{tag}")
        with pytest.raises(BootstrapError, match="username must be"):
            await bootstrap("W", f"user3-{tag}", f"user3.{tag}@example.test", "W", "a b")
        async with household_session(uuid.UUID(int=0)) as db:
            found = await db.scalar(
                text("SELECT account_id FROM auth_resolve_account_by_username(:u)"),
                {"u": f"admin.{tag}"},
            )
        assert found == result.account_id
    finally:
        await _cleanup(result.household_id)


async def test_set_password_hashes_it_and_can_set_the_username() -> None:
    tag = _unique()
    result = await bootstrap("P", f"pw-{tag}", f"pw.{tag}@example.test", "P")
    try:
        with pytest.raises(BootstrapError, match="too easy"):
            await set_password(f"pw.{tag}@example.test", "password1234")
        with pytest.raises(BootstrapError, match="no live account"):
            await set_password(f"nobody.{tag}@example.test", "a sturdy phrase")
        account = await set_password(f"PW.{tag}@example.test", "a sturdy phrase", f"pw.{tag}")
        assert account == result.account_id
        async with household_session(result.household_id) as db:
            row = (
                await db.execute(
                    text("SELECT username, password_hash FROM accounts WHERE id = :a"),
                    {"a": account},
                )
            ).one()
        assert row.username == f"pw.{tag}"
        assert row.password_hash.startswith("$argon2id$")
        assert "a sturdy phrase" not in row.password_hash
    finally:
        await _cleanup(result.household_id)


def test_read_password_takes_stdin_when_piped() -> None:
    assert read_password(io.StringIO("a sturdy phrase\r\n")) == "a sturdy phrase"


def test_read_password_prompts_twice_on_a_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    class Tty(io.StringIO):
        def isatty(self) -> bool:
            return True

    answers = iter(["one phrase here", "another phrase"])
    monkeypatch.setattr("getpass.getpass", lambda prompt: next(answers))
    with pytest.raises(BootstrapError, match="did not match"):
        read_password(Tty())
    monkeypatch.setattr("getpass.getpass", lambda prompt: "same phrase here")
    assert read_password(Tty()) == "same phrase here"


def test_set_password_has_no_password_argument() -> None:
    """Never from argv (shell history, `ps`): argparse refuses a --password flag."""
    with pytest.raises(SystemExit):
        main(["set-password", "--email", "a@b.co", "--password", "a sturdy phrase"])
