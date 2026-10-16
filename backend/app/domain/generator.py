"""The candidate generator (ADR-0007, 03-backend.md "Candidates"). Pure: no I/O.

Given three pools in a fixed order (owned, then the household's streaming services, then
anywhere on TMDB), the night's filters, the watch history, the blocklist and an injected
RNG, pick up to `count` candidates. Each pool is filtered, de-duplicated against the pools
before it, shuffled with the RNG and taken in order, so every qualifying owned title comes
before any streaming one, and streaming before anywhere.

Rules, applied to every pool alike:
- Blocked and excluded (already on the shortlist) titles are always skipped.
- Age cap: on a capped night a title passes only with a known US certification at or
  below the cap. Unrated (no cert, empty, `NR`, anything unknown) is excluded.
- Genre: on a genre night the title must carry that genre; no genres means no match.
- Max runtime: a title over it is skipped. An unknown runtime passes: TMDB list results
  carry no runtime, and the TMDB query already applied `with_runtime.lte`.
- History: a title watched in the last 12 months is skipped unless the family's average
  rating for it is RESCUE_RATING or higher. No ratings means no rescue.

The RNG is the only source of randomness, so the same inputs and seed give the same
output. Titles are identified by TMDB id and/or library movie id; two titles sharing
either one are the same title.
"""

from __future__ import annotations

import random
import uuid
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

Source = Literal["owned", "streaming", "tmdb"]
Key = tuple[str, int | uuid.UUID]

# US MPA ratings, lowest first. The order TMDB's /certification/movie/list gives them,
# minus NR (order 0 there), which counts as unrated here.
US_CERTS: tuple[str, ...] = ("G", "PG", "PG-13", "R", "NC-17")

# TMDB's /genre/movie/list (en-US). Ids are stable; names are what `movies.genres` stores.
GENRES: Mapping[str, int] = {
    "Action": 28,
    "Adventure": 12,
    "Animation": 16,
    "Comedy": 35,
    "Crime": 80,
    "Documentary": 99,
    "Drama": 18,
    "Family": 10751,
    "Fantasy": 14,
    "History": 36,
    "Horror": 27,
    "Music": 10402,
    "Mystery": 9648,
    "Romance": 10749,
    "Science Fiction": 878,
    "TV Movie": 10770,
    "Thriller": 53,
    "War": 10752,
    "Western": 37,
}
GENRE_NAMES: Mapping[int, str] = {v: k for k, v in GENRES.items()}

RESCUE_RATING = 4.0
MAX_COUNT = 20


@dataclass(frozen=True)
class Title:
    title: str
    tmdb_id: int | None = None
    movie_id: uuid.UUID | None = None
    year: int | None = None
    poster_path: str | None = None
    genres: frozenset[str] = frozenset()
    runtime: int | None = None
    us_cert: str | None = None
    providers: tuple[str, ...] = ()

    def keys(self) -> frozenset[Key]:
        out: set[Key] = set()
        if self.tmdb_id is not None:
            out.add(("tmdb", self.tmdb_id))
        if self.movie_id is not None:
            out.add(("movie", self.movie_id))
        return frozenset(out)


@dataclass(frozen=True)
class Filters:
    genre: str | None = None
    max_runtime: int | None = None
    age_cap: str | None = None


@dataclass(frozen=True)
class Pools:
    owned: Sequence[Title] = ()
    streaming: Sequence[Title] = ()
    anywhere: Sequence[Title] = ()


@dataclass(frozen=True)
class Candidate:
    title: Title
    source: Source


@dataclass(frozen=True)
class History:
    """Titles watched in the last 12 months, by key, with the family's average rating
    (None when nobody rated it)."""

    watched: Mapping[Key, float | None] = field(default_factory=dict)


def keys_of(tmdb_id: int | None, movie_id: uuid.UUID | None) -> frozenset[Key]:
    return Title("", tmdb_id=tmdb_id, movie_id=movie_id).keys()


def within_cap(cert: str | None, cap: str | None) -> bool:
    if cap is None:
        return True
    if cert not in US_CERTS:
        return False
    return US_CERTS.index(cert) <= US_CERTS.index(cap)


def _skipped_by_history(title: Title, history: History) -> bool:
    for key in title.keys():
        if key in history.watched:
            avg = history.watched[key]
            if avg is None or avg < RESCUE_RATING:
                return True
    return False


def eligible(title: Title, filters: Filters, history: History, blocked: Collection[Key]) -> bool:
    if any(k in blocked for k in title.keys()):
        return False
    if not within_cap(title.us_cert, filters.age_cap):
        return False
    if filters.genre is not None and filters.genre not in title.genres:
        return False
    if (
        filters.max_runtime is not None
        and title.runtime is not None
        and title.runtime > filters.max_runtime
    ):
        return False
    return not _skipped_by_history(title, history)


def generate(
    pools: Pools,
    filters: Filters,
    history: History,
    blocked: Iterable[Key],
    rng: random.Random,
    count: int,
) -> list[Candidate]:
    """Up to `count` candidates: owned first, then streaming, then anywhere."""
    if not 1 <= count <= MAX_COUNT:
        raise ValueError(f"count must be 1..{MAX_COUNT}")
    if filters.age_cap is not None and filters.age_cap not in US_CERTS:
        raise ValueError("unknown age cap")
    skip = frozenset(blocked)
    seen: set[Key] = set()
    out: list[Candidate] = []
    tiers: tuple[tuple[Source, Sequence[Title]], ...] = (
        ("owned", pools.owned),
        ("streaming", pools.streaming),
        ("tmdb", pools.anywhere),
    )
    for source, pool in tiers:
        tier: list[Title] = []
        for t in pool:
            keys = t.keys()
            if not keys or keys & seen or not eligible(t, filters, history, skip):
                continue
            seen |= keys
            tier.append(t)
        rng.shuffle(tier)
        for t in tier[: count - len(out)]:
            out.append(Candidate(t, source))
        if len(out) == count:
            break
    return out
