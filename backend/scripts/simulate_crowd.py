"""Local crowd simulator: N people, each its own "phone", playing one game through the real API.

A DEV TOOL for looking at the Games screens with a full living room. Run from backend/ against a
LOCAL stack only (docker compose up -d db redis, migrated; never a deployed one):

    uv run python scripts/simulate_crowd.py --players 8 --game bingo-classic --state mid
    uv run python scripts/simulate_crowd.py --players 12 --game scattergories --state revealed

Games: bingo-classic | bingo-thanksgiving | jar | scattergories.
States: lobby | mid | revealed | finished (a state a game has no meaning for maps to the nearest:
bingo "revealed" = "finished"; jar "lobby" = "mid" with no notes).

It seeds a fresh household (like frontend/e2e/seed_night.py), creates the people (varied names,
emoji, colours: long names and kids), joins each as its own device through `/join` and the PIN
bind (`phones.py`'s pattern, test PIN only), and drives the game to the chosen state. Prints one
JSON line: slug, nightCode, gameId, hostCookie, people (name + pin), so Playwright (or a browser)
can sign in as the host / pick a person and look at the TV, host and phone screens.
Same env as the API under test (DATABASE_URL as fnh_app, REDIS_URL, ...).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import secrets
import sys
import time
from typing import Any

sys.path.insert(0, os.getcwd())

from httpx import ASGITransport, AsyncClient, Response  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.cli import bootstrap  # noqa: E402
from app.core.database import household_session  # noqa: E402
from app.core.security import (  # noqa: E402
    ACCOUNT_COOKIE,
    CSRF_HEADER,
    hash_night_code,
    sign_account_session,
)
from app.domain import night_code  # noqa: E402
from app.domain.legal import PRIVACY_VERSION, TERMS_VERSION  # noqa: E402
from app.main import app  # noqa: E402

TEST_PIN = "246810"

# Varied on purpose: long names, kids, plain short ones, one with an apostrophe and an accent.
CROWD = [
    ("Grandma Esperanza", "👵", "#ec4899"),
    ("Leo", "🦖", "#22c55e"),
    ("Mia", "🐼", "#3b82f6"),
    ("Uncle Bartholomew", "🧔", "#f59e0b"),
    ("Ava", "🦄", "#a855f7"),
    ("Tío Rodolfo", "🎸", "#ef4444"),
    ("Jo", "🐸", "#14b8a6"),
    ("Cousin Maximilian-James", "🛹", "#6366f1"),
    ("Nana", "🍪", "#d97706"),
    ("Zoë", "🦋", "#0ea5e9"),
    ("Papa Gus", "🎣", "#84cc16"),
    ("Baby Theodora", "🍼", "#f472b6"),
    ("Aunt Marguerite", "🌷", "#e11d48"),
    ("Sam", "⚽", "#10b981"),
    ("D'Angelo", "🎧", "#8b5cf6"),
    ("Great-Grandpa Wilhelmina-Ann", "🧓", "#64748b"),
]

NOTES = [
    "The whole family under one roof.",
    "Grandma's stuffing, again.",
    "That the dog finally learned to stay off the couch.",
    "Warm socks and a long nap.",
    "A road trip that did not break down.",
    "Everyone making it home safe.",
    "Pie for breakfast, no judgement.",
    "Another year of terrible puns at the table.",
    "A job I like, finally.",
    "Neighbours who shovel the drive.",
    "Video calls with cousins far away.",
    "Leftovers, obviously.",
]

CATEGORIES = [
    "Pie flavors",
    "Side dishes",
    "Things in a pantry",
    "Fall activities",
    "Movie titles",
    "Animals",
]


class Client:
    """One HTTP client with its own cookie jar (a phone, or the host's browser)."""

    def __init__(self) -> None:
        self.http = AsyncClient(transport=ASGITransport(app=app), base_url="https://fnh.test")
        self._csrf: str | None = None

    async def csrf(self) -> str:
        if self._csrf is None:
            resp = await self.http.get("/api/v1/csrf")
            resp.raise_for_status()
            self._csrf = resp.json()["csrf_token"]
        return self._csrf

    async def call(self, method: str, path: str, body: Any = None, **kw: Any) -> Response:
        resp = await self.http.request(
            method, f"/api/v1{path}", json=body, headers={CSRF_HEADER: await self.csrf()}, **kw
        )
        if resp.status_code >= 400:
            raise SystemExit(f"{method} {path} -> {resp.status_code}: {resp.text[:300]}")
        return resp


async def seed_household(n: int, slug: str) -> dict[str, Any]:
    email = f"host-{slug}@sim.test"
    created = await bootstrap(f"Crowd sim {slug}", slug, email, "Sim Host")
    code = night_code.generate()
    people: list[dict[str, Any]] = []
    async with household_session(created.household_id) as db:
        await db.execute(
            text(
                "INSERT INTO household_consents (household_id, account_id, role, terms_version, "
                "privacy_version, guardian) VALUES (:h, :a, 'admin', :t, :p, true)"
            ),
            {
                "h": created.household_id,
                "a": created.account_id,
                "t": TERMS_VERSION,
                "p": PRIVACY_VERSION,
            },
        )
        for name, emoji, color in CROWD[:n]:
            pid = (
                await db.execute(
                    text(
                        "INSERT INTO people (household_id, name, avatar_emoji, color) "
                        "VALUES (:h, :n, :e, :c) RETURNING id"
                    ),
                    {"h": created.household_id, "n": name, "e": emoji, "c": color},
                )
            ).scalar_one()
            people.append({"id": pid, "name": name})
        await db.execute(
            text(
                "INSERT INTO sessions (household_id, title, status, night_code_hash, "
                "host_account_id) VALUES (:h, 'Crowd night', 'draft', :code, :a)"
            ),
            {
                "h": created.household_id,
                "code": hash_night_code(code, created.household_id),
                "a": created.account_id,
            },
        )
    host = Client()
    host.http.cookies.set(
        ACCOUNT_COOKIE,
        sign_account_session(created.account_id, created.household_id, int(time.time())),
        domain="fnh.test",
    )
    host_cookie = host.http.cookies.get(ACCOUNT_COOKIE, domain="fnh.test")
    return {
        "host": host,
        "hostCookie": host_cookie,
        "code": code,
        "people": people,
    }


async def make_phones(slug: str, code: str, people: list[dict[str, Any]]) -> None:
    """Each person gets their own device: night code, then claim them with the test PIN."""
    for p in people:
        phone = Client()
        await phone.call("POST", "/join", {"slug": slug, "night_code": code})
        await phone.call("PUT", f"/devices/me/people/{p['id']}", {"pin": TEST_PIN})
        p["phone"] = phone


def bingo_marks_from(card: dict[str, Any], called: set[int] | None, upto: int) -> list[int]:
    """Indices to mark: the first `upto` playable squares in a row-major order that favours rows."""
    out = []
    for i, sq in enumerate(card["squares"]):
        if sq == "FREE" or i in card["marked"]:
            continue
        if called is not None and not square_called(sq, called):
            continue
        out.append(i)
        if len(out) >= upto:
            break
    return out


def square_called(square: str, called: set[int]) -> bool:
    digits = "".join(ch for ch in square if ch.isdigit())
    return bool(digits) and int(digits) in called


async def drive_bingo(
    host: Client, game_id: str, people: list[dict[str, Any]], classic: bool, state: str
) -> None:
    g = f"/games/{game_id}"
    state = "finished" if state == "revealed" else state
    await host.call("POST", f"{g}/open")
    cards: dict[str, dict[str, Any]] = {}
    for p in people:
        cards[p["name"]] = (
            await p["phone"].call("POST", f"{g}/bingo/join", {"person_id": str(p["id"])})
        ).json()
    if state == "lobby":
        return
    await host.call("POST", f"{g}/start")
    rng = random.Random(7)
    if classic:
        seq = 0
        target = 30 if state == "mid" else 75
        called: set[int] = set()
        while seq < target:
            snap = (await host.call("POST", f"{g}/bingo/draw", {"expected_seq": seq})).json()
            called = {c["value"] for c in snap["bingo"]["calls"]}
            seq += 1
            if state == "finished" and seq % 5 == 0:
                await mark_all_called(people, g, cards, called)
                if await check_winners(host, g, people, cards, limit=4):
                    break
        await mark_all_called(people, g, cards, called)
        if state == "mid":
            return
    else:
        # Thanksgiving: honour-system marks. Players get a staggered number of squares; with
        # end_on_first_win off a few complete a row (marks 4 on the top row).
        for k, p in enumerate(people):
            upto = [0, 2, 4, 6, 9, 12, 15, 18][k % 8]
            if state == "finished" and k % 3 == 0:
                upto = 24
            for idx in rng.sample(range(25), 25):
                if upto <= 0:
                    break
                if idx == 12 or idx in cards[p["name"]]["marked"]:
                    continue
                await p["phone"].call(
                    "PUT", f"{g}/bingo/mark/{idx}", params={"person_id": str(p["id"])}
                )
                cards[p["name"]]["marked"].append(idx)
                upto -= 1
    if state == "finished":
        await host.call("POST", f"{g}/end")


async def mark_all_called(
    people: list[dict[str, Any]], g: str, cards: dict[str, dict[str, Any]], called: set[int]
) -> None:
    for k, p in enumerate(people):
        card = cards[p["name"]]
        # A third of the table is slow at daubing: they mark only some of what was called.
        limit = 99 if k % 3 else 3
        for idx in bingo_marks_from(card, called, limit):
            resp = await p["phone"].call(
                "PUT", f"{g}/bingo/mark/{idx}", params={"person_id": str(p["id"])}
            )
            cards[p["name"]] = resp.json()


async def check_winners(
    host: Client,
    g: str,
    people: list[dict[str, Any]],
    cards: dict[str, dict[str, Any]],
    limit: int,
) -> bool:
    wins = 0
    for p in people:
        if cards[p["name"]]["squares_from_bingo"] == 0 and wins < limit:
            await host.call("POST", f"{g}/bingo/check", {"person_id": str(p["id"])})
            wins += 1
    return wins >= 3


async def drive_jar(host: Client, game_id: str, people: list[dict[str, Any]], state: str) -> None:
    g = f"/games/{game_id}"
    if state == "lobby":
        return
    for k, p in enumerate(people):
        if k % 5 == 4:
            continue  # a couple of people have not dropped a note yet
        body = NOTES[k % len(NOTES)] + (
            " (and a very long extra line to see wrapping)" * (k % 3 == 0)
        )
        await p["phone"].call(
            "POST",
            f"{g}/jar/notes",
            {"person_id": str(p["id"]), "body": body, "anonymous": k % 4 == 3},
        )
    if state == "mid":
        return
    await host.call("POST", f"{g}/jar/start-reveal")
    snap = (await host.call("GET", g)).json()
    total = snap["jar"]["note_count"]
    shown = total if state == "finished" else max(1, total // 2)
    for _ in range(shown):
        await host.call("POST", f"{g}/jar/reveal-next")
    if state == "finished":
        await host.call("POST", f"{g}/end")


async def drive_scatter(
    host: Client, game_id: str, people: list[dict[str, Any]], state: str
) -> None:
    g = f"/games/{game_id}"
    for p in people:
        await p["phone"].call("POST", f"{g}/scatter/join", {"person_id": str(p["id"])})
    if state == "lobby":
        return
    snap = (
        await host.call(
            "POST",
            f"{g}/scatter/rounds",
            {"categories": CATEGORIES, "duration_seconds": 900},
        )
    ).json()
    letter = snap["scatter"]["current"]["letter"]
    words = ["a", "e", "i", "o", "u", "y", "r", "t"]
    for k, p in enumerate(people):
        # 0..6 answered; the last two players answer everything; two players answer nothing.
        answered = [0, 1, 2, 3, 4, 5, 6, 6][k % 8] if k % 5 != 4 else 0
        if k == len(people) - 1:
            answered = 6
        answers = []
        for c in range(answered):
            # Players 1 and 2 give the same word in category 0 (a duplicate), the rest differ.
            suffix = (
                "pple"
                if (c == 0 and k in (1, 2))
                else words[(k + c) % 8] + "n" * (k % 3) + str(k)[:0]
            )
            answers.append({"category_index": c, "text": f"{letter}{suffix}"})
        if answers:
            await p["phone"].call(
                "PUT", f"{g}/scatter/answers", {"person_id": str(p["id"]), "answers": answers}
            )
    if state == "mid":
        return
    await host.call("POST", f"{g}/scatter/reveal")
    if state == "finished":
        await host.call("POST", f"{g}/end")


async def main_async(args: argparse.Namespace) -> dict[str, Any]:
    slug = args.slug or f"sim-{secrets.token_hex(4)}"
    seeded = await seed_household(args.players, slug)
    host: Client = seeded["host"]
    people = seeded["people"]
    await make_phones(slug, seeded["code"], people)

    kind, mode = {
        "bingo-classic": ("bingo", "classic"),
        "bingo-thanksgiving": ("bingo", "thanksgiving"),
        "jar": ("gratitude_jar", "thanksgiving"),
        "scattergories": ("scattergories", "thanksgiving"),
    }[args.game]
    title = {"bingo": "Bingo", "gratitude_jar": "Gratitude Jar", "scattergories": "Scattergories"}[
        kind
    ]
    body: dict[str, Any] = {"kind": kind, "title": title, "mode": mode, "end_on_first_win": False}
    if kind == "gratitude_jar":
        body.update(reveal_mode="manual", allow_anonymous=True)
    game = (await host.call("POST", "/games", body)).json()
    game_id = game["id"]
    if kind == "bingo":
        await drive_bingo(host, game_id, people, mode == "classic", args.state)
    elif kind == "gratitude_jar":
        await drive_jar(host, game_id, people, args.state)
    else:
        await drive_scatter(host, game_id, people, args.state)
    return {
        "slug": slug,
        "nightCode": seeded["code"],
        "gameId": game_id,
        "game": args.game,
        "state": args.state,
        "hostCookie": seeded["hostCookie"],
        "pin": TEST_PIN,
        "people": [p["name"] for p in people],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--players", type=int, default=8, choices=range(1, len(CROWD) + 1))
    parser.add_argument(
        "--game",
        required=True,
        choices=["bingo-classic", "bingo-thanksgiving", "jar", "scattergories"],
    )
    parser.add_argument("--state", default="mid", choices=["lobby", "mid", "revealed", "finished"])
    parser.add_argument("--slug", default=None, help="household slug (default: random sim-xxxx)")
    args = parser.parse_args()
    if os.environ.get("ENVIRONMENT", "development") == "production":
        parser.error("refusing to run against a production environment")
    print(json.dumps(asyncio.run(main_async(args))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
