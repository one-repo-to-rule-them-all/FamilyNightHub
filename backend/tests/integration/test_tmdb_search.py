"""TMDB search proxy and the global tmdb_cache (03-backend.md "Candidates")."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from app.core.database import AsyncSessionLocal
from app.integrations import tmdb as tmdb_api
from tests.integration.phones import Phone, add_account, phone
from tests.integration.seed import SeededHousehold
from tests.integration.tmdb_doubles import down_client, fake_client, tmdb

pytestmark = pytest.mark.integration

Pair = tuple[SeededHousehold, SeededHousehold]
SEARCH = "/api/v1/tmdb/search"


async def _host(p: Phone, h: SeededHousehold) -> None:
    account = await add_account(h.household_id, "host", f"host.{uuid.uuid4().hex[:10]}@ex.test")
    p.sign_in_as(account, h.household_id)


def _key(q: str) -> str:
    params = {"query": q.casefold(), "include_adult": "false", "page": "1"}
    return tmdb_api.cache_key("/search/movie", params)


async def _cache_row(key: str) -> Any:
    async with AsyncSessionLocal() as db, db.begin():
        return (
            await db.execute(
                text("SELECT payload, fetched_at FROM tmdb_cache WHERE cache_key = :k"),
                {"k": key},
            )
        ).first()


async def _put_cache(key: str, payload: dict[str, Any], age: timedelta) -> None:
    async with AsyncSessionLocal() as db, db.begin():
        await db.execute(
            text(
                "INSERT INTO tmdb_cache (cache_key, payload, fetched_at) "
                "VALUES (:k, CAST(:p AS jsonb), :t) ON CONFLICT (cache_key) DO UPDATE "
                "SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at"
            ),
            {"k": key, "p": json.dumps(payload), "t": datetime.now(UTC) - age},
        )


def _one(title: str) -> dict[str, Any]:
    return {"results": [{"id": 1, "title": title, "release_date": "2001-01-01"}]}


async def test_hosts_search_tmdb(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(fake_client()):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get(SEARCH, params={"q": "  Toy   STORY "})
    assert resp.status_code == 200, resp.text
    results = resp.json()
    assert [r["title"] for r in results] == ["Toy Story", "Toy Story 2", "Toy Story 3"]
    assert results[0] == {
        "tmdb_id": 862,
        "title": "Toy Story",
        "year": 1995,
        "poster_path": "/fake-toy-story.jpg",
    }
    assert await _cache_row(_key("toy story")) is not None


async def test_missing_posters_and_dates_come_back_as_null(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(fake_client()):
        async with phone() as p:
            await _host(p, a)
            results = (await p.client.get(SEARCH, params={"q": "untitled poster"})).json()
    assert results == [
        {"tmdb_id": 999001, "title": "Untitled Poster Test", "year": None, "poster_path": None}
    ]


async def test_a_fresh_cache_entry_is_served_without_calling_tmdb(two_households: Pair) -> None:
    a, _ = two_households
    q = f"cached {uuid.uuid4().hex[:8]}"
    await _put_cache(_key(q), _one("From cache"), timedelta(days=29))
    with tmdb(down_client()):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get(SEARCH, params={"q": q})
    assert resp.status_code == 200
    assert [r["title"] for r in resp.json()] == ["From cache"]


async def test_an_entry_older_than_30_days_is_refetched(two_households: Pair) -> None:
    a, _ = two_households
    await _put_cache(_key("moana"), _one("Stale"), timedelta(days=31))
    with tmdb(fake_client()):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get(SEARCH, params={"q": "Moana"})
    assert [r["title"] for r in resp.json()] == ["Moana"]
    row = await _cache_row(_key("moana"))
    assert datetime.now(UTC) - row.fetched_at < timedelta(minutes=5)


async def test_a_stale_entry_beats_an_outage(two_households: Pair) -> None:
    a, _ = two_households
    q = f"stale {uuid.uuid4().hex[:8]}"
    await _put_cache(_key(q), _one("Old but useful"), timedelta(days=45))
    with tmdb(down_client()):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get(SEARCH, params={"q": q})
    assert [r["title"] for r in resp.json()] == ["Old but useful"]


async def test_tmdb_down_is_a_clear_503(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(down_client()):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get(SEARCH, params={"q": f"nothing {uuid.uuid4().hex}"})
    assert resp.status_code == 503
    assert "unavailable" in resp.json()["error"]["message"]


async def test_tmdb_unconfigured_is_a_clear_503(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(None):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get(SEARCH, params={"q": "toy"})
    assert resp.status_code == 503
    assert "not set up" in resp.json()["error"]["message"]


async def test_search_is_for_hosts_only(two_households: Pair) -> None:
    async with phone() as p:
        assert (await p.client.get(SEARCH, params={"q": "toy"})).status_code == 401


async def test_a_blank_query_returns_nothing_and_an_empty_one_is_422(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(down_client()):
        async with phone() as p:
            await _host(p, a)
            assert (await p.client.get(SEARCH, params={"q": "   "})).json() == []
            assert (await p.client.get(SEARCH, params={"q": ""})).status_code == 422


async def test_hosts_list_streaming_services_for_the_settings_picker(
    two_households: Pair,
) -> None:
    a, _ = two_households
    with tmdb(fake_client()):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get("/api/v1/tmdb/providers")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [x["name"] for x in body["providers"]][:2] == ["Netflix", "Disney Plus"]
    assert body["providers"][0] == {
        "provider_id": 8,
        "name": "Netflix",
        "logo_path": "/fake-netflix.jpg",
    }
    assert "JustWatch" in body["attribution"]


async def test_streaming_services_need_tmdb(two_households: Pair) -> None:
    a, _ = two_households
    with tmdb(None):
        async with phone() as p:
            await _host(p, a)
            resp = await p.client.get("/api/v1/tmdb/providers")
    assert resp.status_code == 503
