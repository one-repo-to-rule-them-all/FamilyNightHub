"""Operator commands. Sign-up is invite-only (ADR-0002), so the first admin comes from here.

    python -m app.cli bootstrap --household "The Baez Family" --slug baez \\
        --email you@example.com --name "Rodolfo" [--username rodolfo]
    python -m app.cli set-password --email you@example.com [--username rodolfo]
    python -m app.cli grant-platform --email you@example.com --by "Rodolfo, 2026-10-19"
    python -m app.cli revoke-platform --email you@example.com

`set-password` (ADR-0014) reads the password from stdin when piped, else from a hidden
prompt (twice). Never from argv: arguments land in shell history and `ps`.

On Fly: `fly ssh console -a fnh-api -C "python -m app.cli bootstrap ..."`. It runs as the
app role through RLS like everything else: the new household's id is set as the GUC
before its row is written, which is exactly what the households policy's WITH CHECK allows.

`grant-platform` / `revoke-platform` (ADR-0016) are the only writers of `platform_operators`:
the account is found through the ADR-0009 resolver as the app role, and the row is written
over MIGRATION_DATABASE_URL as the owner, because `fnh_app` can only read that table. The API
can never make an operator.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import re
import sys
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TextIO

from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from app.core import hashing
from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.domain import credentials

SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class BootstrapError(Exception):
    pass


@dataclass(frozen=True)
class Bootstrapped:
    household_id: uuid.UUID
    account_id: uuid.UUID
    join_url: str


def _username(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        return credentials.normalize_username(value)
    except ValueError as exc:
        raise BootstrapError(str(exc)) from None


async def bootstrap(
    household: str, slug: str, email: str, name: str, username: str | None = None
) -> Bootstrapped:
    if not SLUG.match(slug):
        raise BootstrapError("slug must be 3-64 chars of a-z, 0-9 and inner dashes")
    if not EMAIL.match(email.strip()):
        raise BootstrapError("email does not look like an email address")
    if not household.strip() or not name.strip():
        raise BootstrapError("household and name are required")
    login = _username(username)

    household_id = uuid.uuid4()
    try:
        async with household_session(household_id) as db:
            await db.execute(
                text("INSERT INTO households (id, name, join_slug) VALUES (:id, :n, :s)"),
                {"id": household_id, "n": household.strip(), "s": slug},
            )
            await db.execute(
                text("INSERT INTO settings (household_id) VALUES (:id)"), {"id": household_id}
            )
            account_id: uuid.UUID = (
                await db.execute(
                    text(
                        "INSERT INTO accounts (household_id, email, username, display_name, role) "
                        "VALUES (:h, :e, :u, :n, 'admin') RETURNING id"
                    ),
                    {"h": household_id, "e": email.strip(), "u": login, "n": name.strip()},
                )
            ).scalar_one()
            await db.execute(
                text(
                    "INSERT INTO audit_events (household_id, actor_account_id, action, "
                    "target_type, target_id) VALUES (:h, :a, 'household.bootstrapped', "
                    "'household', :h)"
                ),
                {"h": household_id, "a": account_id},
            )
    except IntegrityError as exc:
        constraint = str(exc.orig)
        if "join_slug" in constraint:
            raise BootstrapError(f"slug {slug!r} is already taken") from None
        if "username" in constraint:
            raise BootstrapError(f"username {login!r} is already taken") from None
        if "email" in constraint:
            raise BootstrapError(f"{email!r} already has an account") from None
        raise
    join_url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/j/{slug}"
    return Bootstrapped(household_id, account_id, join_url)


async def set_password(email: str, password: str, username: str | None = None) -> uuid.UUID:
    """Set (or replace) a live account's password, and optionally its username."""
    login = _username(username)
    async with AsyncSessionLocal() as session, session.begin():
        found = (
            await session.execute(
                text("SELECT account_id, household_id FROM auth_resolve_account_by_email(:e)"),
                {"e": email.strip().lower()},
            )
        ).first()
    if found is None:
        raise BootstrapError(f"no live account has the email {email!r}")
    try:
        async with household_session(found.household_id) as db:
            if login is not None:
                await db.execute(
                    text("UPDATE accounts SET username = :u WHERE id = :a"),
                    {"u": login, "a": found.account_id},
                )
            row = (
                await db.execute(
                    text("SELECT username, email FROM accounts WHERE id = :a FOR UPDATE"),
                    {"a": found.account_id},
                )
            ).one()
            try:
                credentials.check_password(password, username=row.username, email=row.email)
            except ValueError as exc:
                raise BootstrapError(str(exc)) from None
            await db.execute(
                text(
                    "UPDATE accounts SET password_hash = :h, password_changed_at = now() "
                    "WHERE id = :a"
                ),
                {"h": await hashing.hash_password(password), "a": found.account_id},
            )
            await db.execute(
                text(
                    "INSERT INTO audit_events (household_id, actor_account_id, action, "
                    "target_type, target_id, data) VALUES (:h, :a, 'account.password_set', "
                    "'account', :a, '{\"via\": \"cli\"}')"
                ),
                {"h": found.household_id, "a": found.account_id},
            )
    except IntegrityError as exc:
        if "username" in str(exc.orig):
            raise BootstrapError(f"username {login!r} is already taken") from None
        raise
    account_id: uuid.UUID = found.account_id
    return account_id


async def _account_for(email: str) -> uuid.UUID:
    if not EMAIL.match(email.strip()):
        raise BootstrapError("email does not look like an email address")
    async with AsyncSessionLocal() as session, session.begin():
        account_id: uuid.UUID | None = await session.scalar(
            text("SELECT account_id FROM auth_resolve_account_by_email(:e)"),
            {"e": email.strip().lower()},
        )
    if account_id is None:
        raise BootstrapError(f"no live account has the email {email!r}")
    return account_id


def _owner_execute(sql: str, params: dict[str, object]) -> int:
    """One statement as the owner role, committed; returns the rows it touched."""
    engine = create_engine(settings.MIGRATION_DATABASE_URL)
    try:
        with engine.begin() as conn:
            return conn.execute(text(sql), params).rowcount
    finally:
        engine.dispose()


async def grant_platform(email: str, granted_by: str) -> uuid.UUID:
    """Make the live account with this email a platform operator (idempotent)."""
    if not granted_by.strip():
        raise BootstrapError("--by is required: who granted it, and when")
    account_id = await _account_for(email)
    await asyncio.to_thread(
        _owner_execute,
        "INSERT INTO platform_operators (account_id, granted_by) VALUES (:a, :b) "
        "ON CONFLICT (account_id) DO UPDATE SET granted_by = EXCLUDED.granted_by",
        {"a": account_id, "b": granted_by.strip()[:120]},
    )
    await asyncio.to_thread(
        _owner_execute,
        "INSERT INTO platform_audit_events (account_id, action, data) "
        "VALUES (:a, 'platform.granted', jsonb_build_object('by', CAST(:b AS text)))",
        {"a": account_id, "b": granted_by.strip()[:120]},
    )
    return account_id


async def revoke_platform(email: str) -> uuid.UUID:
    """Remove the operator row. Their platform session dies on its next request."""
    account_id = await _account_for(email)
    removed = await asyncio.to_thread(
        _owner_execute, "DELETE FROM platform_operators WHERE account_id = :a", {"a": account_id}
    )
    if not removed:
        raise BootstrapError(f"{email!r} is not a platform operator")
    await asyncio.to_thread(
        _owner_execute,
        "INSERT INTO platform_audit_events (account_id, action) VALUES (:a, 'platform.revoked')",
        {"a": account_id},
    )
    return account_id


def read_password(stdin: TextIO | None = None) -> str:
    """One line from stdin when it is piped (`... set-password < file`), else a hidden
    prompt entered twice. Raises BootstrapError if the two prompts differ."""
    stream = stdin or sys.stdin
    if not stream.isatty():
        return stream.readline().rstrip("\r\n")
    first = getpass.getpass("New password: ")
    if getpass.getpass("Again: ") != first:
        raise BootstrapError("the passwords did not match")
    return first


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    boot = commands.add_parser("bootstrap", help="create the household and its first admin")
    boot.add_argument("--household", required=True, help='display name, e.g. "The Baez Family"')
    boot.add_argument("--slug", required=True, help="join slug used in the fridge QR (/j/<slug>)")
    boot.add_argument("--email", required=True, help="admin email (sign-in and password reset)")
    boot.add_argument("--name", required=True, help="admin display name")
    boot.add_argument("--username", help="optional sign-in username (3-32 of a-z 0-9 . _ -)")
    pw = commands.add_parser(
        "set-password", help="set an account's password (read from stdin or a hidden prompt)"
    )
    pw.add_argument("--email", required=True, help="the account's email")
    pw.add_argument("--username", help="also set the sign-in username")
    grant = commands.add_parser(
        "grant-platform", help="make an account a platform operator (ADR-0016)"
    )
    grant.add_argument("--email", required=True, help="the operator's account email")
    grant.add_argument("--by", required=True, help='who granted it, e.g. "Rodolfo, 2026-10-19"')
    revoke = commands.add_parser("revoke-platform", help="remove a platform operator")
    revoke.add_argument("--email", required=True, help="the operator's account email")
    args = parser.parse_args(argv)

    try:
        if args.command == "grant-platform":
            account_id = asyncio.run(grant_platform(args.email, args.by))
            print(f"platform operator: account {account_id} ({args.email})")
            return 0
        if args.command == "revoke-platform":
            account_id = asyncio.run(revoke_platform(args.email))
            print(f"no longer a platform operator: account {account_id} ({args.email})")
            return 0
        if args.command == "set-password":
            account_id = asyncio.run(set_password(args.email, read_password(), args.username))
            print(f"password set for account {account_id} ({args.email})")
            return 0
        result = asyncio.run(
            bootstrap(args.household, args.slug, args.email, args.name, args.username)
        )
    except BootstrapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"household {result.household_id}")
    print(f"admin     {result.account_id} ({args.email})")
    print(f"fridge QR {result.join_url}")
    print(
        "Set a password with `python -m app.cli set-password --email ...`, or use "
        '"Forgot password" in the app to get an emailed link.'
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
