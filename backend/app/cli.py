"""Operator commands. Sign-up is invite-only (ADR-0002), so the first admin comes from here.

    python -m app.cli bootstrap --household "The Baez Family" --slug baez \\
        --email you@example.com --name "Rodolfo"

On Fly: `fly ssh console -a fnh-api -C "python -m app.cli bootstrap ..."`. It runs as the
app role through RLS like everything else: the new household's id is set as the GUC
before its row is written, which is exactly what the households policy's WITH CHECK allows.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import household_session

SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class BootstrapError(Exception):
    pass


@dataclass(frozen=True)
class Bootstrapped:
    household_id: uuid.UUID
    account_id: uuid.UUID
    join_url: str


async def bootstrap(household: str, slug: str, email: str, name: str) -> Bootstrapped:
    if not SLUG.match(slug):
        raise BootstrapError("slug must be 3-64 chars of a-z, 0-9 and inner dashes")
    if not EMAIL.match(email.strip()):
        raise BootstrapError("email does not look like an email address")
    if not household.strip() or not name.strip():
        raise BootstrapError("household and name are required")

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
                        "INSERT INTO accounts (household_id, email, display_name, role) "
                        "VALUES (:h, :e, :n, 'admin') RETURNING id"
                    ),
                    {"h": household_id, "e": email.strip(), "n": name.strip()},
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
        if "email" in constraint:
            raise BootstrapError(f"{email!r} already has an account") from None
        raise
    join_url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/j/{slug}"
    return Bootstrapped(household_id, account_id, join_url)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    boot = commands.add_parser("bootstrap", help="create the household and its first admin")
    boot.add_argument("--household", required=True, help='display name, e.g. "The Baez Family"')
    boot.add_argument("--slug", required=True, help="join slug used in the fridge QR (/j/<slug>)")
    boot.add_argument("--email", required=True, help="admin email for magic-link sign-in")
    boot.add_argument("--name", required=True, help="admin display name")
    args = parser.parse_args(argv)

    try:
        result = asyncio.run(bootstrap(args.household, args.slug, args.email, args.name))
    except BootstrapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"household {result.household_id}")
    print(f"admin     {result.account_id} ({args.email})")
    print(f"fridge QR {result.join_url}")
    print("Sign in from the app with the admin email; a magic link will be sent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
