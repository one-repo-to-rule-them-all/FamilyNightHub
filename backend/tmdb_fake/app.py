"""tmdb-fake: the slice of TMDB v3 the API uses, served from fixtures/movies.json.

Local dev and CI point TMDB_BASE_URL here (docker compose service `tmdb-fake`); tests can
also mount `app` behind httpx.ASGITransport. The fixtures follow the TMDB v3 response
shapes for /search/movie and /movie/{id}; poster paths are fake. Like TMDB it wants a
Bearer token (any value) and answers 404 with TMDB's error body for unknown ids.

Run: uv run uvicorn tmdb_fake.app:app --port 8102
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

FIXTURES = Path(__file__).parent / "fixtures" / "movies.json"
CATALOG: list[dict[str, Any]] = json.loads(FIXTURES.read_text(encoding="utf-8"))
BY_ID = {m["id"]: m for m in CATALOG}
PAGE_SIZE = 20

app = FastAPI(title="tmdb-fake")


def _require_token(authorization: str | None) -> None:
    if not authorization or not authorization.startswith("Bearer ") or len(authorization) < 8:
        raise HTTPException(401, {"status_code": 7, "status_message": "Invalid API key"})


def _summary(movie: dict[str, Any]) -> dict[str, Any]:
    """Search results omit runtime and carry genre_ids instead of genres, as TMDB does."""
    out = {k: v for k, v in movie.items() if k not in ("runtime", "genres")}
    out["genre_ids"] = [g["id"] for g in movie["genres"]]
    return out


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/search/movie")
async def search_movie(
    query: str = Query(""),
    page: int = Query(1, ge=1),
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    _require_token(authorization)
    needle = query.strip().casefold()
    hits = [m for m in CATALOG if needle and needle in m["title"].casefold()]
    start = (page - 1) * PAGE_SIZE
    return {
        "page": page,
        "results": [_summary(m) for m in hits[start : start + PAGE_SIZE]],
        "total_results": len(hits),
        "total_pages": max(1, -(-len(hits) // PAGE_SIZE)),
    }


@app.get("/movie/{movie_id}", response_model=None)
async def movie_details(
    movie_id: int, authorization: str | None = Header(None)
) -> dict[str, Any] | JSONResponse:
    _require_token(authorization)
    movie = BY_ID.get(movie_id)
    if movie is None:
        return JSONResponse(
            {
                "success": False,
                "status_code": 34,
                "status_message": "The resource you requested could not be found.",
            },
            status_code=404,
        )
    return movie
