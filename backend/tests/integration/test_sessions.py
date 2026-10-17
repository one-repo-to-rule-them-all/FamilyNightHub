"""Nights: create, night code, shortlist, open voting and the snapshot (03-backend.md)."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.database import household_session
from app.core.security import ACCOUNT_COOKIE, CSRF_HEADER, hash_night_code
from app.domain import night_code
from app.services import session_service
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.tmdb_doubles import down_client, fake_client, tmdb

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"

SNAPSHOT_KEYS = {
    "id",
    "title",
    "status",
    "voting_method",
    "ballot_size",
    "options",
    "created_at",
    "voting_opened_at",
    "revealed_at",
    "closed_at",
    "result",
    "rating",  # the family average only, from tonight on
    "slideshow",  # the host's TV slideshow control (issue #41)
    "slideshow_started_at",
}
OPTION_KEYS = {"id", "movie_id", "title", "year", "poster_path", "source", "position"}


@pytest.fixture(autouse=True)
def _fake_tmdb() -> Iterator[None]:
    with tmdb(fake_client()):
        yield


async def _send(
    p: Phone, method: str, path: str, body: Any = None, *, csrf: bool = True
) -> Response:
    headers = {CSRF_HEADER: await p.csrf()} if csrf else {}
    return await p.client.request(method, path, json=body, headers=headers)


async def _host(p: Phone, h: SeededHousehold) -> uuid.UUID:
    account = await add_account(h.household_id, "host", f"host.{uuid.uuid4().hex[:10]}@ex.test")
    p.sign_in_as(account, h.household_id)
    return account


async def _new_night(p: Phone, title: str | None = "Friday") -> dict[str, Any]:
    resp = await p.post(BASE, {"title": title})
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def _add(p: Phone, sid: str, body: dict[str, Any]) -> Response:
    return await p.post(f"{BASE}/{sid}/options", body)


async def _audit(h: SeededHousehold, session_id: str) -> list[tuple[str, dict[str, Any]]]:
    async with household_session(h.household_id) as db:
        rows = await db.execute(
            text(
                "SELECT action, data FROM audit_events WHERE target_id = :s "
                "ORDER BY created_at, action"
            ),
            {"s": session_id},
        )
        return [(r.action, r.data) for r in rows]


async def _session_row(h: SeededHousehold, session_id: str) -> Any:
    async with household_session(h.household_id) as db:
        return (
            await db.execute(text("SELECT * FROM sessions WHERE id = :s"), {"s": session_id})
        ).one()


# --- Create + night code -------------------------------------------------------------


async def test_host_creates_a_draft_night_and_sees_the_code_once(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        host = await _host(p, a)
        created = await _new_night(p)
        code = created["night_code"]
        assert night_code.normalize(code) == code
        snap = (await p.client.get(f"{BASE}/{created['session_id']}")).json()
    assert set(snap) == SNAPSHOT_KEYS
    assert snap["status"] == "draft" and snap["ballot_size"] is None and snap["options"] == []
    assert code not in json.dumps(snap)

    row = await _session_row(a, created["session_id"])
    assert row.night_code_hash == hash_night_code(code, a.household_id)
    assert code not in json.dumps([str(v) for v in row])  # only the hash is stored
    assert row.host_account_id == host and row.status == "draft"
    assert [act for act, _ in await _audit(a, created["session_id"])] == ["session.created"]


async def test_the_code_lets_a_phone_join(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        created = await _new_night(host)
    async with phone() as kid:
        resp = await kid.join(a.slug, created["night_code"].lower())
        assert resp.status_code == 200, resp.text
        assert resp.json()["session_id"] == created["session_id"]


async def test_rotating_the_code_kills_the_old_one(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as host:
        await _host(host, a)
        created = await _new_night(host)
        sid, old = created["session_id"], created["night_code"]
        resp = await host.post(f"{BASE}/{sid}/night-code")
        assert resp.status_code == 200
        new = resp.json()["night_code"]
    assert new != old
    async with phone() as kid:
        assert (await kid.join(a.slug, old)).status_code == 400
        assert (await kid.join(a.slug, new)).status_code == 200
    assert (await _session_row(a, sid)).night_code_hash == hash_night_code(new, a.household_id)
    assert "session.code_rotated" in [act for act, _ in await _audit(a, sid)]


async def test_a_closed_night_has_no_code_to_rotate(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], "CLS234", status="closed")
    async with phone() as host:
        await _host(host, a)
        resp = await host.post(f"{BASE}/{a.ids['session']}/night-code")
    assert resp.status_code == 409


async def test_a_code_collision_is_retried(two_households: Pair) -> None:
    a, _ = two_households
    taken = "TAK234"
    codes = iter([taken, taken, "FRE234"])
    async with household_session(a.household_id) as db:
        first = await session_service.create(
            db, a.household_id, a.ids["account"], title=None, generate=lambda: taken
        )
        second = await session_service.create(
            db, a.household_id, a.ids["account"], title=None, generate=lambda: next(codes)
        )
    assert (first.night_code, second.night_code) == (taken, "FRE234")

    with pytest.raises(IntegrityError):
        async with household_session(a.household_id) as db:
            await session_service.create(
                db, a.household_id, a.ids["account"], title=None, generate=lambda: taken
            )


# --- Who may do what ---------------------------------------------------------------


async def test_admins_can_run_nights_too(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        p.sign_in_as(a.ids["account"], a.household_id)  # the seeded account is an admin
        assert (await p.post(BASE, {})).status_code == 201


async def test_a_device_reads_the_night_but_cannot_run_it(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], "MEM234", status="draft")
    async with phone() as kid:
        assert (await kid.join(a.slug, "MEM234")).status_code == 200
        snap = await kid.client.get(f"{BASE}/{a.ids['session']}")
        assert snap.status_code == 200
        assert len(snap.json()["options"]) == 2
        sid = a.ids["session"]
        assert (await kid.post(BASE, {})).status_code == 401
        assert (await kid.post(f"{BASE}/{sid}/open-voting")).status_code == 401
        assert (await kid.post(f"{BASE}/{sid}/night-code")).status_code == 401
        assert (await _add(kid, sid, {"title": "Cars"})).status_code == 401
        assert (await kid.client.get("/api/v1/tmdb/search", params={"q": "toy"})).status_code == 401


async def test_a_bad_host_cookie_falls_back_to_the_device(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], "FBK234", status="draft")
    async with phone() as p:
        assert (await p.join(a.slug, "FBK234")).status_code == 200
        p.client.cookies.set(ACCOUNT_COOKIE, "forged.cookie.value.x", domain="fnh.test")
        assert (await p.client.get(f"{BASE}/{a.ids['session']}")).status_code == 200


async def test_nobody_reads_a_night_without_a_credential(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as stranger:
        assert (await stranger.client.get(f"{BASE}/{a.ids['session']}")).status_code == 401


async def test_another_households_night_is_a_404(two_households: Pair) -> None:
    a, b = two_households
    sid, oid = a.ids["session"], a.ids["option"]
    async with phone() as p:
        await _host(p, b)
        assert (await p.client.get(f"{BASE}/{sid}")).status_code == 404
        assert (await p.post(f"{BASE}/{sid}/night-code")).status_code == 404
        assert (await p.post(f"{BASE}/{sid}/open-voting")).status_code == 404
        assert (await _add(p, sid, {"title": "Cars"})).status_code == 404
        assert (await _send(p, "DELETE", f"{BASE}/{sid}/options/{oid}")).status_code == 404
        order = {"option_ids": [str(a.ids["option2"]), str(oid)]}
        assert (await _send(p, "PUT", f"{BASE}/{sid}/options/order", order)).status_code == 404
        # Nor can b's host shortlist a's movie into b's own night.
        mine = (await _new_night(p))["session_id"]
        resp = await _add(p, mine, {"movie_id": str(a.ids["movie"])})
        assert resp.status_code == 404
    await open_night(b.household_id, b.ids["session"], "BBB234", status="draft")
    async with phone() as b_phone:
        assert (await b_phone.join(b.slug, "BBB234")).status_code == 200
        assert (await b_phone.client.get(f"{BASE}/{sid}")).status_code == 404
    async with household_session(a.household_id) as db:
        count = await db.scalar(
            text("SELECT count(*) FROM options WHERE session_id = :s"), {"s": sid}
        )
    assert count == 2


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "", {}),
        ("POST", "/{sid}/night-code", None),
        ("POST", "/{sid}/options", {"title": "Cars"}),
        ("DELETE", "/{sid}/options/{oid}", None),
        ("PUT", "/{sid}/options/order", {"option_ids": []}),
        ("POST", "/{sid}/open-voting", None),
    ],
)
async def test_every_mutation_needs_the_csrf_header(
    two_households: Pair, method: str, path: str, body: Any
) -> None:
    a, _ = two_households
    sid, oid = a.ids["session"], a.ids["option"]
    async with phone() as p:
        await _host(p, a)
        await p.csrf()  # the cookie is present; only the header is missing
        url = BASE + path.format(sid=sid, oid=oid)
        resp = await _send(p, method, url, body, csrf=False)
    assert resp.status_code == 403
    assert "CSRF" in resp.json()["error"]["message"]
    snap_row = await _session_row(a, str(sid))
    assert snap_row.status == "draft"


# --- Shortlist -----------------------------------------------------------------------


async def test_building_a_shortlist_three_ways(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        lib = await _add(p, sid, {"movie_id": str(a.ids["movie"])})
        assert lib.status_code == 201, lib.text
        picked = await _add(p, sid, {"tmdb_id": 862})
        assert picked.status_code == 201, picked.text
        typed = await _add(p, sid, {"title": "  Grandpa's   home video ", "year": 1998})
        assert typed.status_code == 201, typed.text
        options = typed.json()["options"]
    assert [set(o) for o in options] == [OPTION_KEYS] * 3
    assert [(o["title"], o["source"], o["position"]) for o in options] == [
        ("Paddington", "tmdb", 0),
        ("Toy Story", "tmdb", 1),
        ("Grandpa's home video", "manual", 2),
    ]
    assert options[1]["year"] == 1995 and options[1]["poster_path"] == "/fake-toy-story.jpg"
    assert options[2]["year"] == 1998 and options[2]["poster_path"] is None
    async with household_session(a.household_id) as db:
        movie = (
            await db.execute(
                text("SELECT runtime, genres, tmdb_id FROM movies WHERE id = :m"),
                {"m": options[1]["movie_id"]},
            )
        ).one()
        manual = await db.scalar(
            text("SELECT tmdb_id FROM movies WHERE id = :m"), {"m": options[2]["movie_id"]}
        )
    assert movie.tmdb_id == 862 and movie.runtime == 81 and "Animation" in movie.genres
    assert manual is None
    added = [d for act, d in await _audit(a, sid) if act == "session.option_added"]
    assert sorted(d["source"] for d in added) == ["manual", "tmdb", "tmdb"]


async def test_owned_titles_are_tagged_owned(two_households: Pair) -> None:
    a, _ = two_households
    async with household_session(a.household_id) as db:
        await db.execute(
            text("UPDATE movies SET owned = true WHERE id = :m"), {"m": a.ids["movie"]}
        )
        manual = await db.scalar(
            text("INSERT INTO movies (household_id, title) VALUES (:h, 'Tape') RETURNING id"),
            {"h": a.household_id},
        )
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        await _add(p, sid, {"movie_id": str(a.ids["movie"])})
        resp = await _add(p, sid, {"movie_id": str(manual)})
    assert [o["source"] for o in resp.json()["options"]] == ["owned", "manual"]


async def test_the_same_movie_cannot_be_shortlisted_twice(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        assert (await _add(p, sid, {"tmdb_id": 14160})).status_code == 201
        again = await _add(p, sid, {"tmdb_id": 14160})
        assert again.status_code == 409
        # A typed title reuses the library row, so it's a duplicate too.
        assert (await _add(p, sid, {"title": "Home movie"})).status_code == 201
        assert (await _add(p, sid, {"title": "home MOVIE"})).status_code == 409
        snap = (await p.client.get(f"{BASE}/{sid}")).json()
    assert len(snap["options"]) == 2


async def test_a_picked_tmdb_title_lands_in_the_library_once(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        first = (await _new_night(p))["session_id"]
        second = (await _new_night(p))["session_id"]
        one = (await _add(p, first, {"tmdb_id": 2062})).json()["options"][0]["movie_id"]
        two = (await _add(p, second, {"tmdb_id": 2062})).json()["options"][0]["movie_id"]
    assert one == two


async def test_bad_option_bodies_are_422(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        for body in (
            {},
            {"title": "Cars", "tmdb_id": 1},
            {"title": "   "},
            {"tmdb_id": 862, "year": 1995},
            {"tmdb_id": 0},
        ):
            assert (await _add(p, sid, body)).status_code == 422, body


async def test_an_unknown_tmdb_id_is_a_404(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        resp = await _add(p, sid, {"tmdb_id": 424242})
    assert resp.status_code == 404
    assert "TMDB" in resp.json()["error"]["message"]


async def test_the_shortlist_holds_at_most_eight(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        for i in range(8):
            assert (await _add(p, sid, {"title": f"Film {i}"})).status_code == 201
        ninth = await _add(p, sid, {"title": "Film 8"})
        assert ninth.status_code == 409
        assert "at most 8" in ninth.json()["error"]["message"]
        assert len((await p.client.get(f"{BASE}/{sid}")).json()["options"]) == 8


async def test_remove_and_reorder(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        for t in ("A", "B", "C"):
            await _add(p, sid, {"title": f"{t} {uuid.uuid4().hex[:6]}"})
        ids = [o["id"] for o in (await p.client.get(f"{BASE}/{sid}")).json()["options"]]

        resp = await _send(p, "PUT", f"{BASE}/{sid}/options/order", {"option_ids": ids[::-1]})
        assert resp.status_code == 200
        assert [o["id"] for o in resp.json()["options"]] == ids[::-1]
        assert [o["position"] for o in resp.json()["options"]] == [0, 1, 2]

        for bad in (ids[:2], [*ids, str(uuid.uuid4())], [ids[0], ids[0], ids[1]]):
            resp = await _send(p, "PUT", f"{BASE}/{sid}/options/order", {"option_ids": bad})
            assert resp.status_code == 409, bad

        resp = await _send(p, "DELETE", f"{BASE}/{sid}/options/{ids[1]}")
        assert resp.status_code == 200
        left = resp.json()["options"]
        assert [o["id"] for o in left] == [ids[2], ids[0]]
        assert [o["position"] for o in left] == [0, 1]
        gone = await _send(p, "DELETE", f"{BASE}/{sid}/options/{ids[1]}")
        assert gone.status_code == 404
    actions = [act for act, _ in await _audit(a, sid)]
    assert "session.reordered" in actions and "session.option_removed" in actions


# --- TMDB off or down: typed titles still work ----------------------------------------


async def test_with_tmdb_unconfigured_the_shortlist_takes_typed_titles(
    two_households: Pair,
) -> None:
    a, _ = two_households
    with tmdb(None):
        async with phone() as p:
            await _host(p, a)
            sid = (await _new_night(p))["session_id"]
            resp = await _add(p, sid, {"tmdb_id": 9806})
            assert resp.status_code == 503
            assert "Type the title" in resp.json()["error"]["message"]
            assert (await _add(p, sid, {"title": "The Incredibles"})).status_code == 201
            # A TMDB title already in the library needs no call to TMDB.
            assert (await _add(p, sid, {"tmdb_id": 1})).status_code == 201


async def test_with_tmdb_down_the_shortlist_takes_typed_titles(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(down_client()):
        async with phone() as p:
            await _host(p, a)
            sid = (await _new_night(p))["session_id"]
            assert (await _add(p, sid, {"tmdb_id": 808})).status_code == 503
            assert (await _add(p, sid, {"title": "Shrek"})).status_code == 201


# --- Open voting ---------------------------------------------------------------------


@pytest.mark.parametrize(("n", "k"), [(2, 1), (3, 2), (4, 3), (8, 3)])
async def test_open_voting_fixes_the_ballot_size(two_households: Pair, n: int, k: int) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        for i in range(n):
            await _add(p, sid, {"title": f"Pick {i}"})
        resp = await p.post(f"{BASE}/{sid}/open-voting")
    assert resp.status_code == 200, resp.text
    snap = resp.json()
    assert (snap["status"], snap["ballot_size"]) == ("voting", k)
    assert snap["voting_opened_at"] is not None
    opened = [d for act, d in await _audit(a, sid) if act == "session.voting_opened"]
    assert opened == [{"from": "draft", "to": "voting", "options": n, "ballot_size": k}]


@pytest.mark.parametrize("n", [0, 1])
async def test_open_voting_needs_two_options(two_households: Pair, n: int) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        sid = (await _new_night(p))["session_id"]
        for i in range(n):
            await _add(p, sid, {"title": f"Only {i}"})
        resp = await p.post(f"{BASE}/{sid}/open-voting")
    assert resp.status_code == 409
    assert (await _session_row(a, sid)).status == "draft"


async def test_the_shortlist_locks_once_voting_opens(two_households: Pair) -> None:
    a, _ = two_households
    sid, oid = a.ids["session"], a.ids["option"]
    async with phone() as p:
        await _host(p, a)
        assert (await p.post(f"{BASE}/{sid}/open-voting")).status_code == 200
        assert (await p.post(f"{BASE}/{sid}/open-voting")).status_code == 409
        assert (await _add(p, sid, {"title": "Late entry"})).status_code == 409
        assert (await _send(p, "DELETE", f"{BASE}/{sid}/options/{oid}")).status_code == 409
        order = {"option_ids": [str(a.ids["option2"]), str(oid)]}
        assert (await _send(p, "PUT", f"{BASE}/{sid}/options/order", order)).status_code == 409
        # Rotating the code is still fine mid-vote.
        assert (await p.post(f"{BASE}/{sid}/night-code")).status_code == 200
        snap = (await p.client.get(f"{BASE}/{sid}")).json()
    assert len(snap["options"]) == 2 and snap["status"] == "voting"


# --- Snapshot ------------------------------------------------------------------------


async def test_the_snapshot_never_carries_ballots(two_households: Pair) -> None:
    """The seeded night has a ballot row; nothing about it may reach any screen."""
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], "SNP234", status="voting")
    async with household_session(a.household_id) as db:
        await db.execute(
            text("UPDATE sessions SET ranking = '{\"x\": 1}', tie_seed = 42 WHERE id = :s"),
            {"s": a.ids["session"]},
        )
    async with phone() as kid:
        await kid.join(a.slug, "SNP234")
        resp = await kid.client.get(f"{BASE}/{a.ids['session']}")
    body = resp.json()
    assert set(body) == SNAPSHOT_KEYS
    assert all(set(o) == OPTION_KEYS for o in body["options"])
    raw = resp.text.lower()
    for leak in ("ballot_rank", 'rank"', "ranking", "tie_seed", "winner", "score", "night_code"):
        assert leak not in raw, leak
    assert str(a.ids["ballot_rank"]) not in raw and str(a.ids["person"]) not in raw


async def test_a_revealed_night_reads_as_tonight_after_30_seconds(two_households: Pair) -> None:
    a, _ = two_households
    async with household_session(a.household_id) as db:
        await db.execute(
            text(
                "UPDATE sessions SET status = 'revealed', "
                "revealed_at = now() - interval '1 minute' WHERE id = :s"
            ),
            {"s": a.ids["session"]},
        )
    async with phone() as p:
        await _host(p, a)
        snap = (await p.client.get(f"{BASE}/{a.ids['session']}")).json()
    assert snap["status"] == "tonight"
    assert snap["ballot_size"] == 3  # stored value once out of draft


async def test_an_unknown_night_is_a_404(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        assert (await p.client.get(f"{BASE}/{uuid.uuid4()}")).status_code == 404
