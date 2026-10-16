"""TMDB v3 over HTTP (03-backend.md "Candidates", ADR-0007). HTTP and parsing only.

The read token is server-only (02-environments.md) and never leaves this module. Caching
in `tmdb_cache` lives in app/services/movie_service.py, which owns the database. CI and
local dev point TMDB_BASE_URL at the tmdb-fake service (backend/tmdb_fake/); tests may
also inject an httpx transport. Nothing in CI ever reaches the real API.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from app.core.config import settings
from app.domain.generator import GENRE_NAMES

MAX_CACHE_KEY = 300  # tmdb_cache.cache_key is String(300)


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
    key = f"{path}?{query}" if query else path
    if len(key) <= MAX_CACHE_KEY:
        return key
    # Long discover queries (many providers) still fit the column, and stay readable.
    digest = hashlib.sha256(key.encode()).hexdigest()
    return f"{key[: MAX_CACHE_KEY - 65]}#{digest}"


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


@dataclass(frozen=True)
class DiscoverPage:
    movies: list[TmdbMovie]
    total_pages: int


def parse_discover(payload: dict[str, Any]) -> DiscoverPage:
    """A /discover/movie page. List results carry `genre_ids`, mapped to TMDB's names."""
    movies = []
    for item in payload.get("results") or []:
        if not isinstance(item, dict) or item.get("adult") is True:
            continue
        movie = parse_movie(item)
        names = tuple(GENRE_NAMES[g] for g in item.get("genre_ids") or [] if g in GENRE_NAMES)
        movies.append(
            TmdbMovie(movie.tmdb_id, movie.title, movie.year, movie.poster_path, genres=names)
        )
    total = payload.get("total_pages")
    return DiscoverPage(movies, total if isinstance(total, int) and total > 0 else 1)


# Release types (TMDB /movie/{id}/release_dates): theatrical first, premiere last-but-one.
_CERT_TYPE_ORDER = (3, 2, 4, 5, 6, 1)


def parse_us_cert(payload: dict[str, Any]) -> str | None:
    """The US certification from /movie/{id}/release_dates: the first non-empty one by
    release type (theatrical, limited, digital, physical, TV, premiere). None if unrated."""
    best: tuple[int, str] | None = None
    for country in payload.get("results") or []:
        if not isinstance(country, dict) or country.get("iso_3166_1") != "US":
            continue
        for rel in country.get("release_dates") or []:
            cert = rel.get("certification") if isinstance(rel, dict) else None
            if not isinstance(cert, str) or not cert.strip():
                continue
            rtype = rel.get("type")
            rank = _CERT_TYPE_ORDER.index(rtype) if rtype in _CERT_TYPE_ORDER else 99
            if best is None or rank < best[0]:
                best = (rank, cert.strip()[:8])
    return None if best is None else best[1]


@dataclass(frozen=True)
class Provider:
    provider_id: int
    name: str


def parse_flatrate(payload: dict[str, Any], region: str) -> list[Provider]:
    """Subscription (flatrate) providers for `region` from /movie/{id}/watch/providers.
    This data comes from JustWatch and must be attributed wherever it is shown."""
    country = (payload.get("results") or {}).get(region)
    if not isinstance(country, dict):
        return []
    return [
        Provider(int(p["provider_id"]), str(p["provider_name"]))
        for p in country.get("flatrate") or []
        if isinstance(p, dict) and p.get("provider_id") is not None and p.get("provider_name")
    ]


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


@dataclass(frozen=True)
class ListedProvider:
    provider_id: int
    name: str
    logo_path: str | None
    priority: int


def parse_provider_list(payload: dict[str, Any], region: str) -> list[ListedProvider]:
    """/watch/providers/movie, most prominent in `region` first (JustWatch data)."""
    out = []
    for p in payload.get("results") or []:
        if not isinstance(p, dict) or p.get("provider_id") is None or not p.get("provider_name"):
            continue
        priorities = p.get("display_priorities") or {}
        priority = priorities.get(region, p.get("display_priority"))
        out.append(
            ListedProvider(
                int(p["provider_id"]),
                str(p["provider_name"]),
                _str_or_none(p.get("logo_path")),
                priority if isinstance(priority, int) else 9999,
            )
        )
    return sorted(out, key=lambda p: (p.priority, p.name))
