"""Seeds one household with people and a night for a Playwright test, as the app role.

Run from backend/ (so `app` and its settings resolve), with the same env as the API under test:

    uv run python ../frontend/e2e/seed_night.py --slug e2e-abc123 [--movies 4 --open-voting]
    uv run python ../frontend/e2e/seed_night.py --slug e2e-abc123 --movies 2 --tonight

Prints one JSON line: {"slug", "nightCode", "householdName", "adminEmail", "people": [...],
"sessionId", "movies": [...], "hostCookie"}. Without flags the night is a `draft` with no
shortlist. `--movies N` adds N typed titles through session_service (the host's real path) and
`--open-voting` opens voting, so ballot_size = min(3, N - 1) exactly as the API would fix it.
`--tonight` goes on through the host's close (no ballots, pinned seed) and backdates the reveal
past REVEAL_SETTLE, so the night is `tonight` and its photo album is open (ADR-0005).
`--owned N` puts N owned titles in the library (OWNED: a TMDB one and a home copy, both rated G)
and `--providers 337,8` sets the household's streaming services, so the candidate generator
(ADR-0007) rolls owned titles first, then streaming, against tmdb-fake.
`--no-night` seeds the household and its people only (`sessionId`/`nightCode` are null): the
acceptance spec starts its night from the host's phone, as a family would.
Every account gets the test password E2E_PASSWORD (ADR-0014 login; username `host-{slug}`), and
`--pins` gives every person the PIN E2E_PIN.
`hostCookie` is a signed `fnh_session` value for the household's admin, so a test can act as
the host through the API (close voting with X-FNH-Test-Seed) without a magic-link round trip.
`--host-account` also adds a second account with the `host` role (no `admin:*` permissions) and
prints its signed session as `hostOnlyCookie` (null otherwise), for the admin screens' 403s.

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
import uuid

sys.path.insert(0, os.getcwd())

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.cli import Bootstrapped, bootstrap, set_password  # noqa: E402
from app.core.database import household_session  # noqa: E402
from app.core.hashing import hash_pin  # noqa: E402
from app.core.security import hash_night_code, sign_account_session  # noqa: E402
from app.domain import night_code  # noqa: E402
from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION  # noqa: E402
from app.services import session_service  # noqa: E402

PEOPLE = [
    ("Ava", "🦄", "#ec4899"),
    ("Leo", "🦖", "#22c55e"),
    ("Mia", "🐼", "#3b82f6"),
]

# (title, tmdb_id, year, poster_path, genres): ids and posters as in backend/tmdb_fake.
OWNED: list[tuple[str, int | None, int, str | None, list[str]]] = [
    ("Toy Story", 862, 1995, "/fake-toy-story.jpg", ["Animation", "Family"]),
    ("Grandma's Camcorder Classics", None, 2004, None, ["Family"]),
]

# ADR-0014 test credentials: every seeded account signs in with this password (username
# `host-{slug}` for the admin, `helper-{slug}` for the host account). Test-only value.
E2E_PASSWORD = "e2e family night password"
# `--pins`: every seeded person's PIN, so a spec can start from "everyone has a PIN".
E2E_PIN = "246810"

MOVIES = [
    "Paddington 2",
    "Spirited Away",
    "The Iron Giant",
    "Coco",
    "Wall-E",
    "Up",
    "Moana",
    "Ratatouille",
]


async def _accept_terms(
    db: AsyncSession, household_id: uuid.UUID, account_id: uuid.UUID, role: str
) -> None:
    await db.execute(
        text(
            "INSERT INTO household_consents (household_id, account_id, role, terms_version, "
            "privacy_version, guardian) VALUES (:h, :a, :r, :t, :p, :g)"
        ),
        {
            "h": household_id,
            "a": account_id,
            "r": role,
            "t": TERMS_VERSION,
            "p": PRIVACY_VERSION,
            "g": role == "admin",
        },
    )


async def seed(
    slug: str,
    movies: int,
    open_voting: bool,
    tonight: bool,
    night: bool = True,
    host_account: bool = False,
    owned: int = 0,
    providers: list[int] | None = None,
    pins: bool = False,
) -> dict[str, object]:
    household = f"E2E {slug}"
    email = f"host-{slug}@e2e.test"
    created = await bootstrap(household, slug, email, "E2E Host")
    code: str | None = night_code.generate() if night else None
    session_id = None
    titles = MOVIES[:movies]
    async with household_session(created.household_id) as db:
        # ADR-0017: the admin has accepted the current Terms as a guardian, so the consent
        # screen and gate stay out of the way of every spec but the one that tests them.
        await _accept_terms(db, created.household_id, created.account_id, "admin")
        for name, emoji, color in PEOPLE:
            person_id = (
                await db.execute(
                    text(
                        "INSERT INTO people (household_id, name, avatar_emoji, color) "
                        "VALUES (:h, :n, :e, :c) RETURNING id"
                    ),
                    {"h": created.household_id, "n": name, "e": emoji, "c": color},
                )
            ).scalar_one()
            if pins:
                await db.execute(
                    text("UPDATE people SET pin_hash = :p, pin_set_at = now() WHERE id = :id"),
                    {"p": await hash_pin(person_id, E2E_PIN), "id": person_id},
                )
        host_id: uuid.UUID | None = None
        if host_account:
            host_id = (
                await db.execute(
                    text(
                        "INSERT INTO accounts (household_id, email, display_name, role) "
                        "VALUES (:h, :e, 'E2E Helper', 'host') RETURNING id"
                    ),
                    {"h": created.household_id, "e": f"helper-{slug}@e2e.test"},
                )
            ).scalar_one()
            await _accept_terms(db, created.household_id, host_id, "host")
        for title, tmdb_id, year, poster, genres in OWNED[:owned]:
            await db.execute(
                text(
                    "INSERT INTO movies (household_id, title, tmdb_id, year, poster_path, "
                    "genres, us_cert, owned) VALUES (:h, :t, :tmdb, :y, :p, :g, 'G', true)"
                ),
                {
                    "h": created.household_id,
                    "t": title,
                    "tmdb": tmdb_id,
                    "y": year,
                    "p": poster,
                    "g": genres,
                },
            )
        if providers:
            await db.execute(
                text("UPDATE settings SET streaming_providers = :p WHERE household_id = :h"),
                {"h": created.household_id, "p": providers},
            )
    await set_password(email, E2E_PASSWORD, f"host-{slug}")
    if host_id is not None:
        await set_password(f"helper-{slug}@e2e.test", E2E_PASSWORD, f"helper-{slug}")
    if code is not None:
        session_id = await _seed_night(created, code, titles, open_voting, tonight)
    return {
        "slug": slug,
        "nightCode": code,
        "householdName": household,
        "adminEmail": email,
        "adminUsername": f"host-{slug}",
        "password": E2E_PASSWORD,
        "pin": E2E_PIN if pins else None,
        "people": [name for name, _, _ in PEOPLE],
        "sessionId": None if session_id is None else str(session_id),
        "movies": titles,
        "hostCookie": sign_account_session(
            created.account_id, created.household_id, int(time.time())
        ),
        "hostOnlyCookie": None
        if host_id is None
        else sign_account_session(host_id, created.household_id, int(time.time())),
    }


async def _seed_night(
    created: Bootstrapped, code: str, titles: list[str], open_voting: bool, tonight: bool
) -> uuid.UUID:
    async with household_session(created.household_id) as db:
        session_id: uuid.UUID = (
            await db.execute(
                text(
                    "INSERT INTO sessions (household_id, title, status, night_code_hash, "
                    "host_account_id) VALUES (:h, 'E2E night', 'draft', :code, :a) RETURNING id"
                ),
                {
                    "h": created.household_id,
                    "code": hash_night_code(code, created.household_id),
                    "a": created.account_id,
                },
            )
        ).scalar_one()
        for title in titles:
            await session_service.add_option(
                db,
                created.household_id,
                created.account_id,
                session_id,
                session_service.OptionInput(title=title),
                None,
            )
        if open_voting or tonight:
            await session_service.open_voting(
                db, created.household_id, created.account_id, session_id
            )
        if tonight:
            await session_service.close_voting(
                db, created.household_id, created.account_id, session_id, seed=42
            )
            await db.execute(
                text(
                    "UPDATE sessions SET status = 'tonight', "
                    "revealed_at = now() - interval '5 minutes' WHERE id = :s"
                ),
                {"s": session_id},
            )
    return session_id


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", required=True)
    parser.add_argument("--movies", type=int, default=0, choices=range(len(MOVIES) + 1))
    parser.add_argument("--open-voting", action="store_true")
    parser.add_argument("--tonight", action="store_true", help="needs --movies >= 2")
    parser.add_argument("--no-night", action="store_true", help="household and people only")
    parser.add_argument("--host-account", action="store_true", help="add a host-role account")
    parser.add_argument("--owned", type=int, default=0, choices=range(len(OWNED) + 1))
    parser.add_argument("--providers", default="", help="TMDB provider ids, e.g. 337,8")
    parser.add_argument("--pins", action="store_true", help=f"every person's PIN is {E2E_PIN}")
    args = parser.parse_args()
    if args.tonight and args.movies < 2:
        parser.error("--tonight needs --movies 2 or more")
    if args.no_night and (args.movies or args.open_voting or args.tonight):
        parser.error("--no-night takes no --movies, --open-voting or --tonight")
    providers = [int(p) for p in args.providers.split(",") if p.strip()]
    seeded = seed(
        args.slug,
        args.movies,
        args.open_voting,
        args.tonight,
        not args.no_night,
        args.host_account,
        args.owned,
        providers,
        args.pins,
    )
    print(json.dumps(asyncio.run(seeded)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
