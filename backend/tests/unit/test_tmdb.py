"""TMDB client and parsing against the tmdb-fake app and canned transports. No network."""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from app.core.config import settings
from app.integrations import tmdb
from app.integrations.tmdb import TmdbClient, TmdbNotFound, TmdbUnavailable
from tmdb_fake.app import app as fake_app


def _fake(token: str = "t") -> TmdbClient:
    return TmdbClient("http://fake", token, transport=httpx.ASGITransport(fake_app))


def _canned(handler: Callable[[httpx.Request], httpx.Response]) -> TmdbClient:
    return TmdbClient("http://canned/3/", "t", transport=httpx.MockTransport(handler))


async def test_search_against_the_fake() -> None:
    payload = await _fake().get_json("/search/movie", {"query": "paddington"})
    movies = tmdb.parse_search(payload)
    assert [(m.tmdb_id, m.title, m.year) for m in movies] == [
        (116149, "Paddington", 2014),
        (346648, "Paddington 2", 2017),
    ]
    assert movies[0].runtime is None and movies[0].genres == ()


async def test_details_against_the_fake() -> None:
    movie = tmdb.parse_movie(await _fake().get_json("/movie/14160", {}))
    assert movie.title == "Up" and movie.runtime == 96 and "Animation" in movie.genres


async def test_the_fake_wants_a_token_and_404s_unknown_ids() -> None:
    with pytest.raises(TmdbUnavailable, match="401"):
        await _fake(token="").get_json("/movie/14160", {})
    with pytest.raises(TmdbNotFound):
        await _fake().get_json("/movie/1", {})


async def test_the_fake_has_a_health_check_and_pages() -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(fake_app), base_url="http://f") as c:
        assert (await c.get("/health")).json() == {"status": "ok"}
        page = (
            await c.get(
                "/search/movie",
                params={"query": "", "page": 2},
                headers={"Authorization": "Bearer x"},
            )
        ).json()
    assert page["results"] == [] and page["total_pages"] == 1


async def test_the_token_goes_in_the_header_and_the_path_is_joined() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"results": []})

    await _canned(handler).get_json("/search/movie", {"query": "x"})
    assert seen[0].headers["Authorization"] == "Bearer t"
    assert seen[0].url.path == "/3/search/movie"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, json={}),
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, json=[1, 2]),
    ],
)
async def test_unusable_answers_are_unavailable(response: httpx.Response) -> None:
    with pytest.raises(TmdbUnavailable):
        await _canned(lambda _: response).get_json("/x", {})


async def test_connection_errors_are_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(TmdbUnavailable, match="ReadTimeout"):
        await _canned(refuse).get_json("/x", {})


def test_parse_movie_tolerates_missing_fields() -> None:
    movie = tmdb.parse_movie(
        {"id": "7", "original_title": "Orig", "release_date": "19xx", "runtime": 0, "genres": [{}]}
    )
    assert movie == tmdb.TmdbMovie(7, "Orig", None, None, None, ())
    assert tmdb.parse_movie({"id": 8}).title == "Untitled"
    assert tmdb.parse_search({"results": [{"id": 1, "title": "A"}, "junk"]})[0].title == "A"
    assert tmdb.parse_search({}) == []


def test_cache_key_is_order_independent() -> None:
    assert tmdb.cache_key("/s", {"b": "2", "a": "1"}) == tmdb.cache_key("/s", {"a": "1", "b": "2"})
    assert tmdb.cache_key("/s", {"b": "2", "a": "1"}) == "/s?a=1&b=2"
    assert tmdb.cache_key("/movie/5", {}) == "/movie/5"


def test_configured_client_needs_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "TMDB_READ_TOKEN", None)
    assert tmdb.configured_client() is None
    monkeypatch.setattr(settings, "TMDB_READ_TOKEN", "secret")
    assert isinstance(tmdb.configured_client(), TmdbClient)
