"""POST /sessions/{id}/generate: the candidate generator against the TMDB fake (ADR-0007).

`tmdb_cache` is global and survives between tests, so tests that need TMDB to answer
something specific give their request a unique `max_runtime` (a unique cache key).
"""

from __future__ import annotations

import random
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from httpx import Response
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER
from app.integrations.tmdb import TmdbClient
from tests.integration.phones import Phone, add_account, open_night, phone
from tests.integration.seed import SeededHousehold
from tests.integration.tmdb_doubles import down_client, fake_client, tmdb
from tmdb_fake import app as fake

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
BASE = "/api/v1/sessions"
SEED = {"X-FNH-Test-Seed": "42"}
DISNEY, NETFLIX = 337, 8


@pytest.fixture(autouse=True)
def _fake_tmdb() -> Iterator[None]:
    with tmdb(fake_client()):
        yield


async def _host(p: Phone, h: SeededHousehold) -> None:
    account = await add_account(h.household_id, "host", f"host.{uuid.uuid4().hex[:10]}@ex.test")
    p.sign_in_as(account, h.household_id)


async def _night(p: Phone) -> str:
    resp = await p.post(BASE, {"title": "Roll night"})
    assert resp.status_code == 201, resp.text
    sid: str = resp.json()["session_id"]
    return sid


async def _generate(
    p: Phone, sid: str, body: dict[str, Any], seed: dict[str, str] = SEED
) -> Response:
    headers = {CSRF_HEADER: await p.csrf(), **seed}
    return await p.client.post(f"{BASE}/{sid}/generate", json=body, headers=headers)


async def _sql(hh: SeededHousehold, sql: str, **params: Any) -> Any:
    async with household_session(hh.household_id) as db:
        return (
            (await db.execute(text(sql), params)).all()
            if sql.lstrip().startswith("SELECT")
            else await db.execute(text(sql), params)
        )


async def _movie(h: SeededHousehold, title: str, **cols: Any) -> uuid.UUID:
    cols = {"household_id": h.household_id, "title": title, **cols}
    names = ", ".join(cols)
    values = ", ".join(f":{k}" for k in cols)
    async with household_session(h.household_id) as db:
        movie_id: uuid.UUID = (
            await db.execute(
                text(f"INSERT INTO movies ({names}) VALUES ({values}) RETURNING id"), cols
            )
        ).scalar_one()
    return movie_id


async def _settings(h: SeededHousehold, providers: list[int], cap: str | None = None) -> None:
    await _sql(
        h,
        "UPDATE settings SET streaming_providers = :p, default_age_cap = :c "
        "WHERE household_id = :h",
        p=providers,
        c=cap,
        h=h.household_id,
    )


async def _watched(
    h: SeededHousehold, movie_id: uuid.UUID, ago: timedelta, scores: list[int]
) -> None:
    """A past night this movie won, revealed `ago`, rated `scores` by fresh people."""
    async with household_session(h.household_id) as db:
        sid = (
            await db.execute(
                text(
                    "INSERT INTO sessions (household_id, night_code_hash, host_account_id, "
                    "status, revealed_at, closed_at) VALUES (:h, :c, :a, 'closed', :t, :t) "
                    "RETURNING id"
                ),
                {
                    "h": h.household_id,
                    "c": f"nc{uuid.uuid4().hex}",
                    "a": h.ids["account"],
                    "t": datetime.now(UTC) - ago,
                },
            )
        ).scalar_one()
        oid = (
            await db.execute(
                text(
                    "INSERT INTO options (household_id, session_id, movie_id) "
                    "VALUES (:h, :s, :m) RETURNING id"
                ),
                {"h": h.household_id, "s": sid, "m": movie_id},
            )
        ).scalar_one()
        await db.execute(
            text("UPDATE sessions SET winner_option_id = :o WHERE id = :s"), {"o": oid, "s": sid}
        )
        for score in scores:
            pid = (
                await db.execute(
                    text(
                        "INSERT INTO people (household_id, name, avatar_emoji, color) "
                        "VALUES (:h, :n, '🙂', '#123456') RETURNING id"
                    ),
                    {"h": h.household_id, "n": f"P{uuid.uuid4().hex[:6]}"},
                )
            ).scalar_one()
            await db.execute(
                text(
                    "INSERT INTO ratings (household_id, session_id, person_id, score) "
                    "VALUES (:h, :s, :p, :sc)"
                ),
                {"h": h.household_id, "s": sid, "p": pid, "sc": score},
            )


def _unique_runtime() -> int:
    return random.randint(300, 400)


def _ids(resp: Response) -> list[int | None]:
    return [c["tmdb_id"] for c in resp.json()["candidates"]]


# --- The roll ------------------------------------------------------------------------


async def test_owned_first_then_streaming_then_anywhere(two_households: Pair) -> None:
    a, _ = two_households
    await _settings(a, [DISNEY])
    owned_tmdb = await _movie(
        a, "Toy Story", tmdb_id=862, owned=True, us_cert="G", genres=["Family"]
    )
    owned_home = await _movie(a, "Home video", owned=True, us_cert="G", genres=["Family"])
    async with phone() as p:
        await _host(p, a)
        sid = await _night(p)
        resp = await _generate(p, sid, {"count": 20, "genre": "Family", "age_cap": "PG"})
        snap = (await p.client.get(f"{BASE}/{sid}")).json()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    cands = body["candidates"]
    sources = [c["source"] for c in cands]
    assert sources[:2] == ["owned", "owned"]
    assert {c["movie_id"] for c in cands[:2]} == {str(owned_tmdb), str(owned_home)}
    assert "streaming" in sources and "tmdb" in sources
    assert sources == sorted(sources, key=["owned", "streaming", "tmdb"].index)
    # Toy Story is on Disney+ too, but owned wins and it is not repeated.
    assert _ids(resp).count(862) == 1
    for c in cands:
        if c["source"] == "streaming":
            assert c["providers"] == ["Disney Plus"] and c["movie_id"] is None
        else:
            assert c["providers"] == []
        assert c["us_cert"] in ("G", "PG")
    assert body["age_cap"] == "PG" and body["tmdb_unavailable"] is False
    assert body["attribution"]["tmdb"].startswith("This product uses the TMDB API")
    assert "JustWatch" in body["attribution"]["justwatch"]
    assert snap["options"] == []  # nothing was added


async def test_the_cap_is_enforced_locally_against_tmdbs_nr_quirk(two_households: Pair) -> None:
    """TMDB orders NR at 0, so certification.lte=PG returns NR titles. They never roll."""
    a, _ = two_households
    await _settings(a, [DISNEY])
    leaked = await fake_client().get_json(
        "/discover/movie",
        {
            "certification_country": "US",
            "certification.lte": "PG",
            "with_watch_providers": str(DISNEY),
            "watch_region": "US",
        },
    )
    assert 999002 in [m["id"] for m in leaked["results"]]
    async with phone() as p:
        await _host(p, a)
        sid = await _night(p)
        resp = await _generate(p, sid, {"count": 20, "age_cap": "PG"})
    assert resp.status_code == 200
    assert 999002 not in _ids(resp)


async def test_an_over_cap_title_from_tmdb_is_dropped(two_households: Pair) -> None:
    a, _ = two_households
    r_rated, pg = 7_000_000 + random.randint(0, 99_999), 7_100_000 + random.randint(0, 99_999)

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/discover/movie"):
            results = [
                {"id": r_rated, "title": "Too old for tonight", "genre_ids": []},
                {"id": pg, "title": "Fine tonight", "genre_ids": []},
            ]
            return httpx.Response(200, json={"page": 1, "results": results, "total_pages": 1})
        cert = "R" if f"/{r_rated}/" in path else "PG"
        return httpx.Response(
            200,
            json={
                "id": 1,
                "results": [
                    {"iso_3166_1": "US", "release_dates": [{"certification": cert, "type": 3}]}
                ],
            },
        )

    client = TmdbClient("http://lying-tmdb", "t", transport=httpx.MockTransport(handler))
    over_cap = await _movie(a, "Library copy", tmdb_id=r_rated)  # not owned: gets the cert
    with tmdb(client):
        async with phone() as p:
            await _host(p, a)
            sid = await _night(p)
            resp = await _generate(
                p, sid, {"count": 5, "age_cap": "PG-13", "max_runtime": _unique_runtime()}
            )
    assert resp.status_code == 200, resp.text
    assert _ids(resp) == [pg]
    rows = await _sql(a, "SELECT us_cert FROM movies WHERE id = :m", m=over_cap)
    assert rows[0].us_cert == "R"  # learned and cached on the library row


async def test_owned_certs_are_fetched_once_and_cached_on_the_row(two_households: Pair) -> None:
    a, _ = two_households
    up = await _movie(a, "Up", tmdb_id=14160, owned=True)
    async with phone() as p:
        await _host(p, a)
        sid = await _night(p)
        resp = await _generate(p, sid, {"count": 1, "age_cap": "PG"})
    assert resp.json()["candidates"][0]["movie_id"] == str(up)
    assert resp.json()["candidates"][0]["us_cert"] == "PG"
    rows = await _sql(a, "SELECT us_cert FROM movies WHERE id = :m", m=up)
    assert rows[0].us_cert == "PG"


async def test_history_skips_recent_unless_loved_and_blocked_never_roll(
    two_households: Pair,
) -> None:
    a, _ = two_households
    meh = await _movie(a, "Meh recently", owned=True)
    loved = await _movie(a, "Loved recently", owned=True)
    unrated = await _movie(a, "Unrated recently", owned=True)
    old = await _movie(a, "Meh long ago", owned=True)
    fresh = await _movie(a, "Never watched", owned=True)
    await _movie(a, "Blocked", owned=True, blocked=True)
    await _watched(a, meh, timedelta(days=30), [3, 4])  # avg 3.5
    await _watched(a, loved, timedelta(days=60), [4, 4, 5])
    await _watched(a, unrated, timedelta(days=10), [])
    await _watched(a, old, timedelta(days=400), [1])
    with tmdb(None):
        async with phone() as p:
            await _host(p, a)
            sid = await _night(p)
            resp = await _generate(p, sid, {"count": 20, "age_cap": None})
    body = resp.json()
    assert {c["movie_id"] for c in body["candidates"]} == {str(loved), str(old), str(fresh)}
    assert body["tmdb_unavailable"] is True
    assert body["attribution"]["justwatch"] is None


async def test_titles_already_on_the_shortlist_are_not_rolled(two_households: Pair) -> None:
    a, _ = two_households
    first = await _movie(a, "Already picked", owned=True)
    second = await _movie(a, "Still free", owned=True)
    with tmdb(None):
        async with phone() as p:
            await _host(p, a)
            sid = await _night(p)
            assert (await p.post(f"{BASE}/{sid}/options", {"movie_id": str(first)})).is_success
            resp = await _generate(p, sid, {"count": 5, "age_cap": None})
    assert [c["movie_id"] for c in resp.json()["candidates"]] == [str(second)]


async def test_the_cap_defaults_from_settings_and_null_lifts_it(two_households: Pair) -> None:
    a, _ = two_households
    await _settings(a, [], cap="G")
    g = await _movie(a, "Rated G", owned=True, us_cert="G")
    r = await _movie(a, "Rated R", owned=True, us_cert="R")
    unrated = await _movie(a, "No rating", owned=True)
    with tmdb(None):
        async with phone() as p:
            await _host(p, a)
            sid = await _night(p)
            default = (await _generate(p, sid, {"count": 5})).json()
            lifted = (await _generate(p, sid, {"count": 5, "age_cap": None})).json()
            await _sql(a, "UPDATE sessions SET age_cap = 'R' WHERE id = :s", s=sid)
            night = (await _generate(p, sid, {"count": 5})).json()
    assert default["age_cap"] == "G"
    assert [c["movie_id"] for c in default["candidates"]] == [str(g)]
    assert lifted["age_cap"] is None
    assert {c["movie_id"] for c in lifted["candidates"]} == {str(g), str(r), str(unrated)}
    assert night["age_cap"] == "R"
    assert {c["movie_id"] for c in night["candidates"]} == {str(g), str(r)}


async def test_same_seed_same_roll_and_a_repeat_is_served_from_cache(
    two_households: Pair,
) -> None:
    a, _ = two_households
    await _settings(a, [DISNEY, NETFLIX])
    body = {"count": 8, "max_runtime": _unique_runtime(), "age_cap": "PG"}
    async with phone() as p:
        await _host(p, a)
        sid = await _night(p)
        first = await _generate(p, sid, body)
        calls = len(fake.REQUESTS)
        second = await _generate(p, sid, body)
        assert len(fake.REQUESTS) == calls  # every TMDB response came from tmdb_cache
    assert first.status_code == 200 and first.json() == second.json()
    assert len(first.json()["candidates"]) == 8


async def test_a_streaming_pick_is_added_with_its_source(two_households: Pair) -> None:
    a, _ = two_households
    await _settings(a, [NETFLIX])
    async with phone() as p:
        await _host(p, a)
        sid = await _night(p)
        roll = (await _generate(p, sid, {"count": 3, "genre": "Science Fiction"})).json()
        pick = next(c for c in roll["candidates"] if c["source"] == "streaming")
        assert pick["providers"] == ["Netflix"]
        added = await p.post(
            f"{BASE}/{sid}/options", {"tmdb_id": pick["tmdb_id"], "source": "streaming"}
        )
    assert added.status_code == 201, added.text
    assert [o["source"] for o in added.json()["options"]] == ["streaming"]
    rows = await _sql(a, "SELECT us_cert FROM movies WHERE tmdb_id = :t", t=pick["tmdb_id"])
    assert rows[0].us_cert is not None  # learned at add time


async def test_tmdb_down_still_rolls_owned_titles(two_households: Pair) -> None:
    a, _ = two_households
    owned = await _movie(a, "Shelf copy", owned=True)
    with tmdb(down_client()):
        async with phone() as p:
            await _host(p, a)
            sid = await _night(p)
            resp = await _generate(
                p, sid, {"count": 4, "age_cap": None, "max_runtime": _unique_runtime()}
            )
    assert resp.status_code == 200
    assert [c["movie_id"] for c in resp.json()["candidates"]] == [str(owned)]
    assert resp.json()["tmdb_unavailable"] is True


# --- Guards --------------------------------------------------------------------------


async def test_only_draft_nights_roll(two_households: Pair) -> None:
    a, _ = two_households
    await open_night(a.household_id, a.ids["session"], "ABCD-1234", status="voting")
    async with phone() as p:
        await _host(p, a)
        resp = await _generate(p, str(a.ids["session"]), {"count": 3})
    assert resp.status_code == 409


async def test_another_households_night_is_a_404(two_households: Pair) -> None:
    a, b = two_households
    async with phone() as p:
        await _host(p, a)
        resp = await _generate(p, str(b.ids["session"]), {"count": 3})
    assert resp.status_code == 404


async def test_signed_out_and_csrf_less_calls_are_refused(two_households: Pair) -> None:
    a, _ = two_households
    url = f"{BASE}/{a.ids['session']}/generate"
    async with phone() as p:
        anon = await p.client.post(url, json={"count": 3}, headers={CSRF_HEADER: await p.csrf()})
        await _host(p, a)
        no_csrf = await p.client.post(url, json={"count": 3})
    assert anon.status_code == 401
    assert no_csrf.status_code == 403


@pytest.mark.parametrize(
    "body",
    [{"count": 0}, {"count": 21}, {"genre": "Cartoons"}, {"age_cap": "TV-14"}, {"max_runtime": 5}],
)
async def test_bad_requests_are_422(two_households: Pair, body: dict[str, Any]) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        resp = await _generate(p, str(a.ids["session"]), body)
    assert resp.status_code == 422


async def test_source_goes_with_a_tmdb_id_only(two_households: Pair) -> None:
    a, _ = two_households
    async with phone() as p:
        await _host(p, a)
        resp = await p.post(
            f"{BASE}/{a.ids['session']}/options", {"title": "Cars", "source": "streaming"}
        )
    assert resp.status_code == 422
