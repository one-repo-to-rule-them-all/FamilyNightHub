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


def test_long_cache_keys_are_hashed_to_fit_the_column() -> None:
    params = {"with_watch_providers": "|".join(str(i) for i in range(200))}
    key = tmdb.cache_key("/discover/movie", params)
    assert len(key) == tmdb.MAX_CACHE_KEY and "#" in key
    assert key == tmdb.cache_key("/discover/movie", dict(params))
    other = tmdb.cache_key("/discover/movie", {**params, "page": "2"})
    assert other != key


def test_parse_discover_maps_genre_ids_and_skips_adult() -> None:
    page = tmdb.parse_discover(
        {
            "results": [
                {"id": 1, "title": "A", "genre_ids": [16, 10751, 424242]},
                {"id": 2, "title": "B", "adult": True},
                "junk",
            ],
            "total_pages": 7,
        }
    )
    assert [m.tmdb_id for m in page.movies] == [1]
    assert page.movies[0].genres == ("Animation", "Family")
    assert page.total_pages == 7
    assert tmdb.parse_discover({"total_pages": 0}).total_pages == 1


def test_parse_us_cert_prefers_theatrical_and_ignores_blanks() -> None:
    def us(*releases: object) -> dict[str, object]:
        return {
            "results": [
                {"iso_3166_1": "GB", "release_dates": [{"certification": "15", "type": 3}]},
                {"iso_3166_1": "US", "release_dates": list(releases)},
            ]
        }

    assert (
        tmdb.parse_us_cert(
            us({"certification": "PG", "type": 4}, {"certification": "PG-13", "type": 3})
        )
        == "PG-13"
    )
    assert (
        tmdb.parse_us_cert(
            us({"certification": " ", "type": 3}, {"certification": "R", "type": 99})
        )
        == "R"
    )
    assert tmdb.parse_us_cert(us({"certification": "", "type": 3}, "junk")) is None
    assert tmdb.parse_us_cert({"results": ["junk"]}) is None
    assert tmdb.parse_us_cert({}) is None


def test_parse_flatrate_reads_the_region() -> None:
    payload = {
        "results": {
            "US": {
                "flatrate": [
                    {"provider_id": 8, "provider_name": "Netflix"},
                    {"provider_id": None, "provider_name": "Broken"},
                    "junk",
                ],
                "rent": [{"provider_id": 2, "provider_name": "Apple TV"}],
            }
        }
    }
    assert tmdb.parse_flatrate(payload, "US") == [tmdb.Provider(8, "Netflix")]
    assert tmdb.parse_flatrate(payload, "GB") == []
    assert tmdb.parse_flatrate({}, "US") == []


async def test_the_fake_discovers_like_tmdb() -> None:
    fake = _fake()
    family = await fake.get_json("/discover/movie", {"with_genres": "16,10751"})
    assert family["total_results"] >= 10
    either = await fake.get_json("/discover/movie", {"with_genres": "878|10751"})
    assert either["total_results"] > family["total_results"]
    capped = await fake.get_json(
        "/discover/movie", {"certification_country": "US", "certification.lte": "G"}
    )
    ids = {m["id"] for m in capped["results"]}
    assert 862 in ids and 999002 in ids  # NR is order 0 at TMDB
    assert 14160 not in ids and 999003 not in ids  # PG; no US release at all
    netflix = await fake.get_json(
        "/discover/movie",
        {
            "with_watch_providers": "8",
            "watch_region": "US",
            "with_watch_monetization_types": "flatrate",
        },
    )
    assert {m["id"] for m in netflix["results"]} == {346648, 808, 603}
    rent = await fake.get_json(
        "/discover/movie", {"with_watch_providers": "8", "with_watch_monetization_types": "rent"}
    )
    assert rent["results"] == []
    short = await fake.get_json(
        "/discover/movie", {"with_runtime.lte": "85", "vote_count.gte": 500}
    )
    assert {m["id"] for m in short["results"]} == {862, 999001}  # no runtime counts as 0
    with pytest.raises(TmdbUnavailable, match="400"):
        await fake.get_json("/discover/movie", {"page": "501"})


async def test_the_fake_serves_release_dates_and_providers() -> None:
    fake = _fake()
    assert tmdb.parse_us_cert(await fake.get_json("/movie/603/release_dates", {})) == "R"
    assert tmdb.parse_us_cert(await fake.get_json("/movie/999003/release_dates", {})) is None
    flat = tmdb.parse_flatrate(await fake.get_json("/movie/603/watch/providers", {}), "US")
    assert [p.name for p in flat] == ["Netflix", "Max"]
    listed = await fake.get_json("/watch/providers/movie", {"watch_region": "US"})
    assert {p["provider_id"] for p in listed["results"]} >= {8, 337, 9, 1899, 15}
    for path in ("/movie/1/release_dates", "/movie/1/watch/providers"):
        with pytest.raises(TmdbNotFound):
            await fake.get_json(path, {})


def test_parse_provider_list_orders_by_regional_priority() -> None:
    payload = {
        "results": [
            {"provider_id": 1, "provider_name": "B", "display_priorities": {"US": 5}},
            {
                "provider_id": 2,
                "provider_name": "A",
                "display_priority": 1,
                "display_priorities": {"CA": 9},
                "logo_path": "/a.jpg",
            },
            {"provider_id": 3, "provider_name": "C", "display_priority": "x"},
            {"provider_id": None, "provider_name": "Broken"},
            "junk",
        ]
    }
    listed = tmdb.parse_provider_list(payload, "US")
    assert [(p.provider_id, p.priority) for p in listed] == [(2, 1), (1, 5), (3, 9999)]
    assert listed[0].logo_path == "/a.jpg" and listed[1].logo_path is None
    assert tmdb.parse_provider_list({}, "US") == []
