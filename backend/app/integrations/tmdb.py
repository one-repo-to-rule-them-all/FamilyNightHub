"""TMDB v3 over HTTP (03-backend.md "Candidates", ADR-0007). HTTP and parsing only.

The read token is server-only (02-environments.md) and never leaves this module. Caching
in `tmdb_cache` lives in app/services/movie_service.py, which owns the database. CI and
local dev point TMDB_BASE_URL at the tmdb-fake service (backend/tmdb_fake/); tests may
also inject an httpx transport. Nothing in CI ever reaches the real API.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from app.core.config import settings


class TmdbUnavailable(Exception):
    """TMDB is unreachable, timed out, or answered with an error we can't use."""


class TmdbNotFound(Exception):
    """TMDB answered 404 for this id."""


@dataclass(frozen=True)
class TmdbMovie:
    tmdb_id: int
    title: str
    year: int | None
    poster_path: str | None
    runtime: int | None = None
    genres: tuple[str, ...] = ()


def cache_key(path: str, params: dict[str, str]) -> str:
    """Stable key for `tmdb_cache`: the path plus its params in sorted order."""
    query = urlencode(sorted(params.items()))
    return f"{path}?{query}" if query else path


def _year(release_date: Any) -> int | None:
    if isinstance(release_date, str) and len(release_date) >= 4 and release_date[:4].isdigit():
        return int(release_date[:4])
    return None


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def parse_movie(item: dict[str, Any]) -> TmdbMovie:
    """One movie from a search result or a details response (details add runtime/genres)."""
    genres = tuple(
        str(g["name"]) for g in item.get("genres") or [] if isinstance(g, dict) and g.get("name")
    )
    runtime = item.get("runtime")
    return TmdbMovie(
        tmdb_id=int(item["id"]),
        title=str(item.get("title") or item.get("original_title") or "Untitled"),
        year=_year(item.get("release_date")),
        poster_path=_str_or_none(item.get("poster_path")),
        runtime=runtime if isinstance(runtime, int) and runtime > 0 else None,
        genres=genres,
    )


def parse_search(payload: dict[str, Any]) -> list[TmdbMovie]:
    return [parse_movie(r) for r in payload.get("results") or [] if isinstance(r, dict)]


class TmdbClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._transport = transport

    async def get_json(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                headers={"Authorization": f"Bearer {self._token}", "Accept": "application/json"},
                timeout=self._timeout,
                transport=self._transport,
            ) as client:
                resp = await client.get(path, params=params)
        except httpx.HTTPError as exc:
            raise TmdbUnavailable(type(exc).__name__) from exc
        if resp.status_code == 404:
            raise TmdbNotFound(path)
        if resp.status_code != 200:
            raise TmdbUnavailable(f"HTTP {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise TmdbUnavailable("invalid JSON") from exc
        if not isinstance(body, dict):
            raise TmdbUnavailable("unexpected body")
        return body


def configured_client() -> TmdbClient | None:
    """The client from Settings, or None when TMDB is not configured (no read token)."""
    if not settings.TMDB_READ_TOKEN:
        return None
    return TmdbClient(
        settings.TMDB_BASE_URL, settings.TMDB_READ_TOKEN, timeout=settings.TMDB_TIMEOUT_SECONDS
    )
