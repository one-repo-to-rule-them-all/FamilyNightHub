"""Movie library admin: list/filter, flags, bulk add of owned titles (ADR-0007).

TMDB is the in-process tmdb-fake (or a down / absent TMDB). `tmdb_cache` is global and
outlives a test, so lines that must miss the cache carry a unique suffix.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import text

from app.core.database import AsyncSessionLocal, household_session
from app.integrations.tmdb import TmdbClient
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.tmdb_doubles import down_client, fake_client, tmdb
from tmdb_fake.app import app as fake_app

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
CODE = "MVE234"
MOVIES = "/api/v1/admin/movies"
BULK = f"{MOVIES}/bulk"
CONFIRM = f"{MOVIES}/bulk/confirm"


def _as_admin(p: Phone, h: SeededHousehold) -> None:
    p.sign_in_as(h.ids["account"], h.household_id)


def _unique(title: str) -> str:
    return f"{title} {uuid.uuid4().hex[:8]}"


async def _sql(house: SeededHousehold, sql: str, **params: Any) -> list[Any]:
    async with household_session(house.household_id) as db:
        result: Any = await db.execute(text(sql), params)
        return list(result.all()) if result.returns_rows else []


async def _movie(house: SeededHousehold, title: str, **flags: Any) -> uuid.UUID:
    cols = ", ".join(["household_id", "title", *flags])
    vals = ", ".join([":h", ":t", *(f":{k}" for k in flags)])
    rows = await _sql(
        house,
        f"INSERT INTO movies ({cols}) VALUES ({vals}) RETURNING id",
        h=house.household_id,
        t=title,
        **flags,
    )
    movie_id: uuid.UUID = rows[0].id
    return movie_id


async def _actions(house: SeededHousehold, action: str) -> list[Any]:
    return await _sql(
        house,
        "SELECT target_id, data FROM audit_events WHERE action = :a ORDER BY created_at",
        a=action,
    )


async def _bulk(p: Phone, *lines: tuple[str, int | None]) -> dict[str, Any]:
    resp = await p.post(BULK, {"titles": [{"title": t, "year": y} for t, y in lines]})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


# --- Permissions and isolation -------------------------------------------------------


async def test_library_needs_admin_movies_and_csrf(two_households: Pair) -> None:
    a, _ = two_households
    host = await add_account(a.household_id, "host", f"host.{uuid.uuid4().hex[:8]}@ex.test")
    movie = str(a.ids["movie"])
    async with phone() as p:
        p.sign_in_as(host, a.household_id)
        assert (await p.client.get(MOVIES)).status_code == 403
        assert (await p.patch(f"{MOVIES}/{movie}", {"owned": True})).status_code == 403
        assert (await p.post(BULK, {"titles": [{"title": "Coco"}]})).status_code == 403
        assert (await p.post(CONFIRM, {"picks": [{"title": "Coco"}]})).status_code == 403
    async with phone() as p:
        _as_admin(p, a)
        await p.csrf()
        assert (await p.client.patch(f"{MOVIES}/{movie}", json={"owned": True})).status_code == 403
        assert (await p.client.post(BULK, json={"titles": [{"title": "Coco"}]})).status_code == 403
    await open_night(a.household_id, a.ids["session"], CODE)
    async with phone() as member:
        assert (await member.join(a.slug, CODE)).status_code == 200
        assert (await member.client.get(MOVIES)).status_code == 401
        assert (await member.patch(f"{MOVIES}/{movie}", {"owned": True})).status_code == 401


async def test_another_households_movie_is_404_and_never_listed(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as p:
        _as_admin(p, a)
        resp = await p.patch(f"{MOVIES}/{b.ids['movie']}", {"owned": True})
        assert resp.status_code == 404
        assert (await p.patch(f"{MOVIES}/{uuid.uuid4()}", {"owned": True})).status_code == 404
        listed = (await p.client.get(MOVIES, params={"limit": 200})).json()
    ids = {m["id"] for m in listed["items"]}
    assert str(a.ids["movie"]) in ids and str(b.ids["movie"]) not in ids
    assert (await _sql(b, "SELECT owned FROM movies WHERE id = :m", m=b.ids["movie"]))[
        0
    ].owned is False


# --- List -----------------------------------------------------------------------------


async def test_list_searches_filters_and_paginates(two_households: Pair) -> None:
    a, _ = two_households
    await _movie(a, "Zebra Night", owned=True)
    await _movie(a, "Zebra Day", watchlist=True)
    await _movie(a, "Zebra 100% Real", blocked=True)
    async with phone() as p:
        _as_admin(p, a)
        everything = (await p.client.get(MOVIES, params={"q": "  zebra "})).json()
        owned = (await p.client.get(MOVIES, params={"q": "zebra", "owned": "true"})).json()
        not_owned = (await p.client.get(MOVIES, params={"q": "zebra", "owned": "false"})).json()
        watch = (await p.client.get(MOVIES, params={"watchlist": "true"})).json()
        blocked = (await p.client.get(MOVIES, params={"blocked": "true"})).json()
        percent = (await p.client.get(MOVIES, params={"q": "100%"})).json()
        underscore = (await p.client.get(MOVIES, params={"q": "_"})).json()
        page2 = (await p.client.get(MOVIES, params={"q": "zebra", "limit": 2, "offset": 2})).json()
        bad = await p.client.get(MOVIES, params={"limit": 0})

    assert [m["title"] for m in everything["items"]] == [
        "Zebra 100% Real",
        "Zebra Day",
        "Zebra Night",
    ]
    assert everything["total"] == 3
    assert [m["title"] for m in owned["items"]] == ["Zebra Night"]
    assert [m["title"] for m in not_owned["items"]] == ["Zebra 100% Real", "Zebra Day"]
    assert [m["title"] for m in watch["items"]] == ["Zebra Day"]
    assert [m["title"] for m in blocked["items"]] == ["Zebra 100% Real"]
    assert [m["title"] for m in percent["items"]] == ["Zebra 100% Real"]
    assert underscore["total"] == 0
    assert page2 == {
        "items": [everything["items"][2]],
        "total": 3,
        "limit": 2,
        "offset": 2,
    }
    assert set(everything["items"][0]) == {
        "id",
        "tmdb_id",
        "title",
        "year",
        "poster_path",
        "owned",
        "watchlist",
        "blocked",
        "created_at",
    }
    assert bad.status_code == 422


# --- Flags ----------------------------------------------------------------------------


async def test_flags_change_only_what_is_sent_and_are_audited(two_households: Pair) -> None:
    a, _ = two_households
    movie = await _movie(a, "Flag Test", watchlist=True)
    async with phone() as p:
        _as_admin(p, a)
        first = await p.patch(f"{MOVIES}/{movie}", {"owned": True, "watchlist": True})
        second = await p.patch(f"{MOVIES}/{movie}", {"blocked": True, "watchlist": False})
        same = await p.patch(f"{MOVIES}/{movie}", {"blocked": True})
    assert first.status_code == 200, first.text
    assert (first.json()["owned"], first.json()["watchlist"], first.json()["blocked"]) == (
        True,
        True,
        False,
    )
    assert (second.json()["owned"], second.json()["watchlist"], second.json()["blocked"]) == (
        True,
        False,
        True,
    )
    assert same.json() == second.json()
    audit = [r for r in await _actions(a, "movie.updated") if r.target_id == movie]
    assert [r.data for r in audit] == [
        {"owned": {"from": False, "to": True}},
        {"blocked": {"from": False, "to": True}, "watchlist": {"from": True, "to": False}},
    ]


# --- Bulk add -------------------------------------------------------------------------


async def test_bulk_add_matches_asks_and_reports_misses(two_households: Pair) -> None:
    a, b = two_households
    with tmdb(fake_client()):
        async with phone() as p:
            _as_admin(p, a)
            body = await _bulk(
                p,
                ("  coco ", None),
                ("Toy", None),
                (_unique("Nothing Like This"), None),
                ("Wall", 2008),
                ("Up", 1999),
            )
    statuses = [(line["title"], line["status"]) for line in body["lines"]]
    assert statuses[0] == ("coco", "matched")
    assert statuses[1] == ("Toy", "ambiguous")
    assert statuses[2][1] == "not_found"
    assert statuses[3] == ("Wall", "matched")
    assert statuses[4] == ("Up", "not_found")  # wrong year narrows to nothing
    assert body["tmdb_unavailable"] is False
    assert "not endorsed or certified by TMDB" in body["attribution"]

    coco, toy, miss, walle, _up = body["lines"]
    assert coco["movie"]["tmdb_id"] == 354912 and coco["movie"]["owned"] is True
    assert coco["already_owned"] is False and coco["candidates"] == []
    assert [c["tmdb_id"] for c in toy["candidates"]] == [862, 863, 10193]
    assert toy["movie"] is None
    assert miss["movie"] is None and miss["candidates"] == []
    assert walle["movie"]["tmdb_id"] == 10681

    rows = await _sql(
        a, "SELECT tmdb_id, owned, runtime FROM movies WHERE tmdb_id IN (354912, 10681)"
    )
    assert sorted((r.tmdb_id, r.owned) for r in rows) == [(10681, True), (354912, True)]
    assert all(r.runtime for r in rows)  # details fetched, so the runtime filter works
    assert await _sql(b, "SELECT id FROM movies WHERE tmdb_id = 354912") == []
    audit = await _actions(a, "movie.bulk_added")
    assert len(audit) == 1
    assert audit[0].target_id is None
    data = audit[0].data
    assert (data["matched"], data["ambiguous"], data["not_found"], data["added_manual"]) == (
        2,
        1,
        2,
        0,
    )
    assert sorted(data["movie_ids"]) == sorted([coco["movie"]["id"], walle["movie"]["id"]])


async def test_a_repeat_paste_reuses_rows_and_writes_no_audit(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(fake_client()):
        async with phone() as p:
            _as_admin(p, a)
            first = await _bulk(p, ("Ratatouille", None))
            again = await _bulk(p, ("ratatouille", 2007))
    assert first["lines"][0]["already_owned"] is False
    assert again["lines"][0]["already_owned"] is True
    assert again["lines"][0]["movie"]["id"] == first["lines"][0]["movie"]["id"]
    assert len(await _sql(a, "SELECT id FROM movies WHERE tmdb_id = 2062")) == 1
    assert len(await _actions(a, "movie.bulk_added")) == 1


async def test_an_existing_unowned_movie_becomes_owned(two_households: Pair) -> None:
    a, _ = two_households
    await _sql(
        a,
        "INSERT INTO movies (household_id, tmdb_id, title, watchlist) "
        "VALUES (:h, 808, 'Shrek', true)",
        h=a.household_id,
    )
    with tmdb(fake_client()):
        async with phone() as p:
            _as_admin(p, a)
            body = await _bulk(p, ("Shrek", 2001))
    line = body["lines"][0]
    assert line["status"] == "matched" and line["already_owned"] is False
    assert (line["movie"]["owned"], line["movie"]["watchlist"]) == (True, True)


async def test_confirm_resolves_ambiguous_lines(two_households: Pair) -> None:
    a, _ = two_households
    typed = _unique("Grandpa's Tape")
    with tmdb(fake_client()):
        async with phone() as p:
            _as_admin(p, a)
            resp = await p.post(
                CONFIRM,
                {
                    "picks": [
                        {"title": "Toy", "tmdb_id": 863},
                        {"title": typed, "year": 1988},
                        {"title": "Ghost", "tmdb_id": 424242},
                    ]
                },
            )
    assert resp.status_code == 200, resp.text
    pick, manual, ghost = resp.json()["lines"]
    assert (pick["status"], pick["movie"]["tmdb_id"], pick["movie"]["title"]) == (
        "matched",
        863,
        "Toy Story 2",
    )
    assert (manual["status"], manual["movie"]["tmdb_id"], manual["movie"]["year"]) == (
        "added_manual",
        None,
        1988,
    )
    assert manual["movie"]["owned"] is True
    assert ghost["status"] == "not_found" and ghost["movie"] is None
    audit = await _actions(a, "movie.bulk_confirmed")
    assert sorted(audit[0].data["movie_ids"]) == sorted(
        [pick["movie"]["id"], manual["movie"]["id"]]
    )


async def test_tmdb_down_adds_typed_titles(two_households: Pair) -> None:
    a, _ = two_households
    one, two = _unique("Basement VHS"), _unique("Attic DVD")
    with tmdb(down_client()):
        async with phone() as p:
            _as_admin(p, a)
            body = await _bulk(p, (one, 1994), (two, None))
            picked = await p.post(
                CONFIRM, {"picks": [{"title": "Finding Nemo", "tmdb_id": 777777}]}
            )
    assert body["tmdb_unavailable"] is True
    assert [line["status"] for line in body["lines"]] == ["added_manual", "added_manual"]
    assert [line["movie"]["tmdb_id"] for line in body["lines"]] == [None, None]
    assert body["lines"][0]["movie"]["year"] == 1994
    rows = await _sql(a, "SELECT owned FROM movies WHERE title IN (:x, :y)", x=one, y=two)
    assert [r.owned for r in rows] == [True, True]
    nemo = picked.json()
    assert nemo["tmdb_unavailable"] is True
    assert nemo["lines"][0]["status"] == "added_manual"
    assert nemo["lines"][0]["movie"]["title"] == "Finding Nemo"
    assert audit_flag(await _actions(a, "movie.bulk_added")) is True


def audit_flag(rows: list[Any]) -> bool:
    flag: bool = rows[-1].data["tmdb_unavailable"]
    return flag


async def test_no_tmdb_configured_adds_typed_titles(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(None):
        async with phone() as p:
            _as_admin(p, a)
            body = await _bulk(p, (_unique("Home Movie"), None))
    assert body["tmdb_unavailable"] is True
    assert body["lines"][0]["status"] == "added_manual"


async def test_tmdb_failing_part_way_costs_one_request(two_households: Pair) -> None:
    """After the first failure no later line calls TMDB (a hung TMDB is one timeout)."""
    a, _ = two_households
    calls: list[str] = []
    fake = httpx.ASGITransport(fake_app)

    class FailsAfterFirstSearch(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path == "/search/movie" and calls.count("/search/movie") > 1:
                raise httpx.ConnectError("TMDB went away", request=request)
            return await fake.handle_async_request(request)

    client = TmdbClient("http://tmdb-flaky", "t", transport=FailsAfterFirstSearch())
    first, second, third = _unique("Coco"), _unique("Second"), _unique("Third")
    with tmdb(client):
        async with phone() as p:
            _as_admin(p, a)
            body = await _bulk(p, (first, None), (second, None), (third, None))
    assert [line["status"] for line in body["lines"]] == [
        "not_found",
        "added_manual",
        "added_manual",
    ]
    assert body["tmdb_unavailable"] is True
    assert calls.count("/search/movie") == 2


async def test_tmdb_failing_on_details_adds_the_line_as_typed(two_households: Pair) -> None:
    a, _ = two_households
    async with AsyncSessionLocal() as db, db.begin():
        await db.execute(text("DELETE FROM tmdb_cache WHERE cache_key LIKE '/movie/150540%'"))
    fake = httpx.ASGITransport(fake_app)

    class NoDetails(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path.startswith("/movie/"):
                raise httpx.ConnectError("TMDB went away", request=request)
            return await fake.handle_async_request(request)

    with tmdb(TmdbClient("http://tmdb-flaky", "t", transport=NoDetails())):
        async with phone() as p:
            _as_admin(p, a)
            body = await _bulk(p, ("Inside Out", 2015), ("Shrek", None))
    assert body["tmdb_unavailable"] is True
    assert [line["status"] for line in body["lines"]] == ["added_manual", "added_manual"]
    assert body["lines"][0]["movie"]["title"] == "Inside Out"


@pytest.mark.parametrize(
    "body",
    [
        {"titles": []},
        {"titles": [{"title": "   "}]},
        {"titles": [{"title": "x" * 301}]},
        {"titles": [{"title": "Coco", "year": 1800}]},
        {"titles": [{"title": f"T{i}"} for i in range(101)]},
    ],
)
async def test_bulk_input_is_validated(two_households: Pair, body: dict[str, Any]) -> None:
    a, _ = two_households
    async with phone() as p:
        _as_admin(p, a)
        assert (await p.post(BULK, body)).status_code == 422
