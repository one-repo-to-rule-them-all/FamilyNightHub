"""tmdb-fake: the slice of TMDB v3 the API uses, served from fixtures/.

Local dev and CI point TMDB_BASE_URL here (docker compose service `tmdb-fake`); tests can
also mount `app` behind httpx.ASGITransport. The fixtures follow the TMDB v3 response
shapes (checked against developer.themoviedb.org, 2026-10-15) for /search/movie,
/movie/{id}, /discover/movie, /movie/{id}/release_dates, /movie/{id}/watch/providers and
/watch/providers/movie. Genre and provider ids are TMDB's; poster paths and streaming
availability are illustrative. Like TMDB it wants a Bearer token (any value), answers 404
with TMDB's error body for unknown ids, and rejects pages above 500 (status_code 22).

Discover filters the way TMDB does, including its US certification order where NR is 0:
`certification.lte=PG-13` also matches NR titles, which is one reason the API re-checks
the cap locally (ADR-0007). Every request path is appended to `REQUESTS` so tests can
assert cache hits.

Run: uv run uvicorn tmdb_fake.app:app --port 8102
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


CATALOG: list[dict[str, Any]] = _load("movies.json")
BY_ID = {m["id"]: m for m in CATALOG}
RELEASE_DATES: dict[str, dict[str, Any]] = _load("release_dates.json")
WATCH_PROVIDERS: dict[str, dict[str, Any]] = _load("watch_providers.json")
PROVIDERS: dict[str, Any] = _load("providers.json")
PAGE_SIZE = 20
MAX_PAGE = 500
# TMDB's /certification/movie/list order for US.
US_CERT_ORDER = {"NR": 0, "G": 1, "PG": 2, "PG-13": 3, "R": 4, "NC-17": 5}
REQUESTS: list[str] = []

app = FastAPI(title="tmdb-fake")


def _require_token(authorization: str | None, path: str) -> None:
    REQUESTS.append(path)
    if not authorization or not authorization.startswith("Bearer ") or len(authorization) < 8:
        raise HTTPException(401, {"status_code": 7, "status_message": "Invalid API key"})


def _not_found() -> JSONResponse:
    return JSONResponse(
        {
            "success": False,
            "status_code": 34,
            "status_message": "The resource you requested could not be found.",
        },
        status_code=404,
    )


def _summary(movie: dict[str, Any]) -> dict[str, Any]:
    """List results omit runtime and carry genre_ids instead of genres, as TMDB does."""
    out = {k: v for k, v in movie.items() if k not in ("runtime", "genres")}
    out["genre_ids"] = [g["id"] for g in movie["genres"]]
    return out


def _page(hits: list[dict[str, Any]], page: int) -> dict[str, Any] | JSONResponse:
    if page > MAX_PAGE:
        return JSONResponse(
            {
                "success": False,
                "status_code": 22,
                "status_message": "Invalid page: Pages start at 1 and max at 500. "
                "They are expected to be an integer.",
            },
            status_code=400,
        )
    start = (page - 1) * PAGE_SIZE
    return {
        "page": page,
        "results": [_summary(m) for m in hits[start : start + PAGE_SIZE]],
        "total_results": len(hits),
        "total_pages": max(1, -(-len(hits) // PAGE_SIZE)),
    }


def _ids(value: str | None) -> tuple[set[int], bool]:
    """A comma (AND) or pipe (OR) separated id list: (ids, any_of)."""
    if not value:
        return set(), False
    return {int(v) for v in value.replace("|", ",").split(",") if v.strip()}, "|" in value


def _matches(have: set[int], want: set[int], any_of: bool) -> bool:
    if not want:
        return True
    return bool(have & want) if any_of else want <= have


def _us_certs(movie_id: int) -> list[str]:
    results = RELEASE_DATES.get(str(movie_id), {}).get("results", [])
    return [
        r["certification"]
        for country in results
        if country["iso_3166_1"] == "US"
        for r in country["release_dates"]
        if r["certification"]
    ]


def _flatrate_ids(movie_id: int, region: str) -> set[int]:
    country = WATCH_PROVIDERS.get(str(movie_id), {}).get("results", {}).get(region, {})
    return {p["provider_id"] for p in country.get("flatrate", [])}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/search/movie", response_model=None)
async def search_movie(
    query: str = Query(""),
    page: int = Query(1, ge=1),
    authorization: str | None = Header(None),
) -> dict[str, Any] | JSONResponse:
    _require_token(authorization, "/search/movie")
    needle = query.strip().casefold()
    return _page([m for m in CATALOG if needle and needle in m["title"].casefold()], page)


@app.get("/discover/movie", response_model=None)
async def discover_movie(
    page: int = Query(1, ge=1),
    with_genres: str | None = None,
    with_runtime_lte: int | None = Query(None, alias="with_runtime.lte"),
    vote_count_gte: float | None = Query(None, alias="vote_count.gte"),
    certification_country: str | None = None,
    certification_lte: str | None = Query(None, alias="certification.lte"),
    with_watch_providers: str | None = None,
    watch_region: str | None = None,
    with_watch_monetization_types: str | None = None,
    authorization: str | None = Header(None),
) -> dict[str, Any] | JSONResponse:
    _require_token(authorization, "/discover/movie")
    genres, genres_any = _ids(with_genres)
    providers, providers_any = _ids(with_watch_providers)
    hits = []
    for m in sorted(CATALOG, key=lambda m: -m["popularity"]):
        if not _matches({g["id"] for g in m["genres"]}, genres, genres_any):
            continue
        if with_runtime_lte is not None and (m["runtime"] or 0) > with_runtime_lte:
            continue
        if vote_count_gte is not None and m["vote_count"] < vote_count_gte:
            continue
        if certification_country == "US" and certification_lte in US_CERT_ORDER:
            cap = US_CERT_ORDER[certification_lte]
            if not any(US_CERT_ORDER.get(c, 99) <= cap for c in _us_certs(m["id"])):
                continue
        if providers:
            # The fixtures only carry flatrate availability, which is all the API asks for.
            if with_watch_monetization_types not in (None, "flatrate"):
                continue
            have = _flatrate_ids(m["id"], watch_region or "US")
            if not _matches(have, providers, providers_any):
                continue
        hits.append(m)
    return _page(hits, page)


@app.get("/watch/providers/movie")
async def provider_list(
    watch_region: str | None = None, authorization: str | None = Header(None)
) -> dict[str, Any]:
    _require_token(authorization, "/watch/providers/movie")
    return PROVIDERS


@app.get("/movie/{movie_id}/release_dates", response_model=None)
async def release_dates(
    movie_id: int, authorization: str | None = Header(None)
) -> dict[str, Any] | JSONResponse:
    _require_token(authorization, f"/movie/{movie_id}/release_dates")
    found = RELEASE_DATES.get(str(movie_id))
    return _not_found() if found is None else found


@app.get("/movie/{movie_id}/watch/providers", response_model=None)
async def watch_providers(
    movie_id: int, authorization: str | None = Header(None)
) -> dict[str, Any] | JSONResponse:
    _require_token(authorization, f"/movie/{movie_id}/watch/providers")
    found = WATCH_PROVIDERS.get(str(movie_id))
    return _not_found() if found is None else found


@app.get("/movie/{movie_id}", response_model=None)
async def movie_details(
    movie_id: int, authorization: str | None = Header(None)
) -> dict[str, Any] | JSONResponse:
    _require_token(authorization, f"/movie/{movie_id}")
    movie = BY_ID.get(movie_id)
    return _not_found() if movie is None else movie
