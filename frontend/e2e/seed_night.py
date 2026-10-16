"""Seeds one household with people and an open night for a Playwright test, as the app role.

Run from backend/ (so `app` and its settings resolve), with the same env as the API under test:

    uv run python ../frontend/e2e/seed_night.py --slug e2e-abc123

Prints one JSON line: {"slug", "nightCode", "householdName", "adminEmail", "people": [...],
"hostSession"}. `hostSession` is a signed `fnh_session` cookie value for the admin (the same
signer the magic-link verify uses), so host/TV tests can start signed in without MailHog.
Every test seeds its own household, so tests never share state and reruns need no cleanup.
It goes through app.cli.bootstrap (the real first-admin path) and household_session (RLS, GUC
set per transaction), and hashes the night code with the real pepper, exactly like the API.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.getcwd())

from sqlalchemy import text  # noqa: E402

from app.cli import bootstrap  # noqa: E402
from app.core.database import household_session  # noqa: E402
from app.core.security import hash_night_code, sign_account_session  # noqa: E402
from app.domain import night_code  # noqa: E402

PEOPLE = [
    ("Ava", "🦄", "#ec4899"),
    ("Leo", "🦖", "#22c55e"),
    ("Mia", "🐼", "#3b82f6"),
]


async def seed(slug: str) -> dict[str, object]:
    household = f"E2E {slug}"
    email = f"host-{slug}@e2e.test"
    created = await bootstrap(household, slug, email, "E2E Host")
    code = night_code.generate()
    async with household_session(created.household_id) as db:
        for name, emoji, color in PEOPLE:
            await db.execute(
                text(
                    "INSERT INTO people (household_id, name, avatar_emoji, color) "
                    "VALUES (:h, :n, :e, :c)"
                ),
                {"h": created.household_id, "n": name, "e": emoji, "c": color},
            )
        await db.execute(
            text(
                "INSERT INTO sessions (household_id, title, status, night_code_hash, "
                "host_account_id) VALUES (:h, 'E2E night', 'draft', :code, :a)"
            ),
            {
                "h": created.household_id,
                "code": hash_night_code(code, created.household_id),
                "a": created.account_id,
            },
        )
    return {
        "slug": slug,
        "nightCode": code,
        "householdName": household,
        "adminEmail": email,
        "people": [name for name, _, _ in PEOPLE],
        "hostSession": sign_account_session(
            created.account_id, created.household_id, int(time.time())
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(seed(args.slug))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
