"""Movies for the shortlist: TMDB search through the global cache, and upserting the
household's `movies` rows (03-backend.md "Candidates").

`tmdb_cache` is global (not household data), keyed by request path + params. An entry is
served for up to CACHE_TTL; after that it is refetched, and if TMDB is down the stale
entry is still served rather than failing the host mid-shortlist.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations import tmdb
from app.integrations.tmdb import TmdbClient, TmdbMovie, TmdbNotFound, TmdbUnavailable
from app.services.errors import NotFound, Unavailable

CACHE_TTL = timedelta(days=30)
SEARCH_LIMIT = 20

UNCONFIGURED = "Movie search is not set up. Type the title instead."
DOWN = "Movie search is unavailable right now. Type the title instead."

# The payload is bound as JSONB so asyncpg encodes the dict itself.
_UPSERT_CACHE = text(
    "INSERT INTO tmdb_cache (cache_key, payload, fetched_at) VALUES (:k, :p, now()) "
    "ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()"
).bindparams(bindparam("p", type_=JSONB))


async def _cached_get(
    db: AsyncSession, client: TmdbClient | None, path: str, params: dict[str, str]
) -> dict[str, Any]:
    if client is None:
        raise Unavailable(UNCONFIGURED)
    key = tmdb.cache_key(path, params)
    row = (
        await db.execute(
            text("SELECT payload, fetched_at FROM tmdb_cache WHERE cache_key = :k"), {"k": key}
        )
    ).first()
    if row is not None and datetime.now(UTC) - row.fetched_at < CACHE_TTL:
        cached: dict[str, Any] = row.payload
        return cached
    try:
        payload = await client.get_json(path, params)
    except TmdbUnavailable:
        if row is not None:
            stale: dict[str, Any] = row.payload
            return stale
        raise Unavailable(DOWN) from None
    await db.execute(_UPSERT_CACHE, {"k": key, "p": payload})
    return payload


def _normalize_query(q: str) -> str:
    return " ".join(q.split())


async def search(db: AsyncSession, client: TmdbClient | None, q: str) -> list[TmdbMovie]:
    query = _normalize_query(q)
    if not query:
        return []
    params = {"query": query.casefold(), "include_adult": "false", "page": "1"}
    payload = await _cached_get(db, client, "/search/movie", params)
    return tmdb.parse_search(payload)[:SEARCH_LIMIT]


async def details(db: AsyncSession, client: TmdbClient | None, tmdb_id: int) -> TmdbMovie:
    try:
        payload = await _cached_get(db, client, f"/movie/{tmdb_id}", {})
    except TmdbNotFound:
        raise NotFound("No such movie on TMDB") from None
    return tmdb.parse_movie(payload)


async def upsert_from_tmdb(
    db: AsyncSession, household_id: uuid.UUID, client: TmdbClient | None, tmdb_id: int
) -> uuid.UUID:
    """The household's movie for this TMDB id. An existing row is used without calling
    TMDB, so a title picked once stays addable while TMDB is down."""
    existing: uuid.UUID | None = await db.scalar(
        text("SELECT id FROM movies WHERE household_id = :h AND tmdb_id = :t"),
        {"h": household_id, "t": tmdb_id},
    )
    if existing is not None:
        return existing
    movie = await details(db, client, tmdb_id)
    movie_id: uuid.UUID = (
        await db.execute(
            text(
                """
                INSERT INTO movies (household_id, tmdb_id, title, year, poster_path, runtime,
                                    genres)
                VALUES (:h, :t, :title, :year, :poster, :runtime, :genres)
                ON CONFLICT (household_id, tmdb_id) WHERE tmdb_id IS NOT NULL
                DO UPDATE SET title = EXCLUDED.title
                RETURNING id
                """
            ),
            {
                "h": household_id,
                "t": movie.tmdb_id,
                "title": movie.title[:300],
                "year": movie.year,
                "poster": movie.poster_path,
                "runtime": movie.runtime,
                "genres": [g[:40] for g in movie.genres],
            },
        )
    ).scalar_one()
    return movie_id


async def upsert_manual(
    db: AsyncSession, household_id: uuid.UUID, title: str, year: int | None
) -> uuid.UUID:
    """A typed title with no TMDB id. Reuses the household's existing manual entry for the
    same title and year rather than piling up duplicates in the library."""
    clean = " ".join(title.split())
    existing: uuid.UUID | None = await db.scalar(
        text(
            "SELECT id FROM movies WHERE household_id = :h AND tmdb_id IS NULL "
            "AND lower(title) = lower(:t) AND year IS NOT DISTINCT FROM :y "
            "ORDER BY created_at LIMIT 1"
        ),
        {"h": household_id, "t": clean, "y": year},
    )
    if existing is not None:
        return existing
    movie_id: uuid.UUID = (
        await db.execute(
            text("INSERT INTO movies (household_id, title, year) VALUES (:h, :t, :y) RETURNING id"),
            {"h": household_id, "t": clean, "y": year},
        )
    ).scalar_one()
    return movie_id
