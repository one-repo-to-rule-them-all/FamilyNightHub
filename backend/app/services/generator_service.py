"""The candidate generator for a draft night (ADR-0007, 03-backend.md "Candidates").

Loads what `domain/generator.py` needs and runs it; nothing is added to the shortlist
here. The host adds the ones they like through the shortlist endpoint.

- Pools, lazily and in order: the household's owned titles (database); then, only if the
  roll is still short, TMDB discover on the household's streaming services (flatrate, in
  the household's region); then TMDB discover anywhere, with a vote-count floor. Each
  TMDB pool is one page picked with the injected RNG within min(total_pages, PAGE_WINDOW)
  (TMDB itself stops at page 500). Every TMDB response goes through the 30-day
  `tmdb_cache` in movie_service.
- Age cap: the request's (an explicit null means no cap tonight), else the night's
  `sessions.age_cap`, else `settings.default_age_cap`. It goes into the discover query
  (`certification_country=US&certification.lte=`) and is re-checked locally against the
  US certification from /movie/{id}/release_dates, because TMDB's own order puts NR at 0
  and so returns NR titles under any cap. A learned certification is cached on every
  `movies` row of the household with that TMDB id.
- If TMDB is off or down, owned titles still roll and `tmdb_unavailable` says so.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import generator
from app.domain.generator import Candidate, Filters, History, Key, Pools, Title
from app.integrations import tmdb
from app.integrations.tmdb import TmdbClient, TmdbMovie, TmdbNotFound
from app.services import movie_service
from app.services.errors import Conflict, NotFound, Unavailable

PAGE_WINDOW = 50
VOTE_FLOOR = 200
HISTORY_MONTHS = 12

TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB."
JUSTWATCH_NOTICE = "Streaming availability data provided by JustWatch."

_UNSET: Any = object()


@dataclass(frozen=True)
class GenerateInput:
    count: int
    genre: str | None = None
    max_runtime: int | None = None
    # _UNSET: use the night's cap, else the household default. None: no cap tonight.
    age_cap: Any = _UNSET


@dataclass(frozen=True)
class Roll:
    candidates: list[Candidate]
    age_cap: str | None
    tmdb_unavailable: bool


@dataclass(frozen=True)
class _Household:
    providers: list[int]
    region: str
    default_age_cap: str | None


async def _draft_cap(
    db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID
) -> str | None:
    row = (
        await db.execute(
            text("SELECT status, age_cap FROM sessions WHERE id = :s AND household_id = :h"),
            {"s": session_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    if row.status != "draft":
        raise Conflict("Candidates can only be rolled while the shortlist is a draft")
    cap: str | None = row.age_cap
    return cap


async def _household(db: AsyncSession, household_id: uuid.UUID) -> _Household:
    row = (
        await db.execute(
            text(
                "SELECT streaming_providers, region, default_age_cap FROM settings "
                "WHERE household_id = :h"
            ),
            {"h": household_id},
        )
    ).first()
    if row is None:
        return _Household([], "US", None)
    return _Household(sorted(set(row.streaming_providers or [])), row.region, row.default_age_cap)


async def _skip_keys(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> set[Key]:
    """Blocked titles plus the ones already on this night's shortlist."""
    rows = await db.execute(
        text(
            "SELECT m.id, m.tmdb_id FROM movies m WHERE m.household_id = :h AND (m.blocked "
            "OR m.id IN (SELECT o.movie_id FROM options o WHERE o.session_id = :s))"
        ),
        {"h": household_id, "s": session_id},
    )
    keys: set[Key] = set()
    for r in rows:
        keys |= generator.keys_of(r.tmdb_id, r.id)
    return keys


async def _history(db: AsyncSession, household_id: uuid.UUID) -> History:
    """Winners revealed in the last 12 months, with the family's average rating of that
    title across every night it won."""
    rows = await db.execute(
        text(
            f"""
            SELECT m.id, m.tmdb_id,
                   (SELECT avg(r.score) FROM ratings r
                      JOIN sessions s2 ON s2.id = r.session_id
                      JOIN options o2 ON o2.id = s2.winner_option_id
                     WHERE o2.movie_id = m.id) AS avg_score
              FROM sessions s
              JOIN options o ON o.id = s.winner_option_id
              JOIN movies m ON m.id = o.movie_id
             WHERE s.household_id = :h
               AND s.revealed_at >= now() - interval '{HISTORY_MONTHS} months'
            """
        ),
        {"h": household_id},
    )
    watched: dict[Key, float | None] = {}
    for r in rows:
        avg = None if r.avg_score is None else float(r.avg_score)
        for key in generator.keys_of(r.tmdb_id, r.id):
            watched[key] = avg
    return History(watched)


async def _library_certs(db: AsyncSession, household_id: uuid.UUID) -> dict[int, str]:
    rows = await db.execute(
        text(
            "SELECT tmdb_id, us_cert FROM movies WHERE household_id = :h "
            "AND tmdb_id IS NOT NULL AND us_cert IS NOT NULL"
        ),
        {"h": household_id},
    )
    return {r.tmdb_id: r.us_cert for r in rows}


async def _owned(
    db: AsyncSession, household_id: uuid.UUID, client: TmdbClient | None, cap: str | None
) -> list[Title]:
    rows = await db.execute(
        text(
            "SELECT id, tmdb_id, title, year, poster_path, genres, runtime, us_cert "
            "FROM movies WHERE household_id = :h AND owned AND NOT blocked ORDER BY created_at"
        ),
        {"h": household_id},
    )
    out = []
    for r in rows.all():
        cert = r.us_cert
        if cert is None and cap is not None and r.tmdb_id is not None:
            cert = await movie_service.us_cert(db, household_id, client, r.tmdb_id)
        out.append(
            Title(
                title=r.title,
                tmdb_id=r.tmdb_id,
                movie_id=r.id,
                year=r.year,
                poster_path=r.poster_path,
                genres=frozenset(r.genres or ()),
                runtime=r.runtime,
                us_cert=cert,
            )
        )
    return out


def _discover_params(filters: Filters) -> dict[str, str]:
    params = {"include_adult": "false", "sort_by": "popularity.desc"}
    if filters.genre is not None:
        params["with_genres"] = str(generator.GENRES[filters.genre])
    if filters.max_runtime is not None:
        params["with_runtime.lte"] = str(filters.max_runtime)
    if filters.age_cap is not None:
        params["certification_country"] = "US"
        params["certification.lte"] = filters.age_cap
    return params


async def _discover(
    db: AsyncSession,
    household_id: uuid.UUID,
    client: TmdbClient | None,
    params: dict[str, str],
    filters: Filters,
    page_rng: random.Random,
    certs: dict[int, str],
) -> list[Title]:
    first = tmdb.parse_discover(
        await movie_service.cached_get(db, client, "/discover/movie", {**params, "page": "1"})
    )
    page = page_rng.randint(1, min(first.total_pages, PAGE_WINDOW))
    chosen = first
    if page != 1:
        chosen = tmdb.parse_discover(
            await movie_service.cached_get(
                db, client, "/discover/movie", {**params, "page": str(page)}
            )
        )
    out = []
    for m in chosen.movies:
        cert = certs.get(m.tmdb_id)
        if cert is None and filters.age_cap is not None:
            cert = await movie_service.us_cert(db, household_id, client, m.tmdb_id)
        out.append(_title(m, cert))
    return out


def _title(m: TmdbMovie, cert: str | None) -> Title:
    return Title(
        title=m.title,
        tmdb_id=m.tmdb_id,
        year=m.year,
        poster_path=m.poster_path,
        genres=frozenset(m.genres),
        runtime=m.runtime,
        us_cert=cert,
    )


async def _with_providers(
    db: AsyncSession, client: TmdbClient | None, c: Candidate, home: _Household
) -> Candidate:
    """Name the household's services a streaming candidate is on (JustWatch data)."""
    assert c.title.tmdb_id is not None
    try:
        payload = await movie_service.cached_get(
            db, client, f"/movie/{c.title.tmdb_id}/watch/providers", {}
        )
    except (Unavailable, TmdbNotFound):
        return c
    mine = set(home.providers)
    names = tuple(
        p.name for p in tmdb.parse_flatrate(payload, home.region) if p.provider_id in mine
    )
    return Candidate(replace(c.title, providers=names), c.source)


async def generate(
    db: AsyncSession,
    household_id: uuid.UUID,
    session_id: uuid.UUID,
    req: GenerateInput,
    client: TmdbClient | None,
    seed: int,
) -> Roll:
    night_cap = await _draft_cap(db, household_id, session_id)
    home = await _household(db, household_id)
    cap = (night_cap or home.default_age_cap) if req.age_cap is _UNSET else req.age_cap
    filters = Filters(genre=req.genre, max_runtime=req.max_runtime, age_cap=cap)
    skip = await _skip_keys(db, household_id, session_id)
    history = await _history(db, household_id)

    def roll(pools: Pools) -> list[Candidate]:
        return generator.generate(pools, filters, history, skip, random.Random(seed), req.count)

    pools = Pools(owned=await _owned(db, household_id, client, cap))
    out = roll(pools)
    unavailable = False
    if len(out) < req.count:
        page_rng = random.Random(seed ^ 0x5EED)
        certs = await _library_certs(db, household_id)
        params = _discover_params(filters)
        try:
            if home.providers:
                streaming_params = {
                    **params,
                    "with_watch_providers": "|".join(str(p) for p in home.providers),
                    "watch_region": home.region,
                    "with_watch_monetization_types": "flatrate",
                }
                pools = Pools(
                    pools.owned,
                    streaming=await _discover(
                        db, household_id, client, streaming_params, filters, page_rng, certs
                    ),
                )
                out = roll(pools)
            if len(out) < req.count:
                anywhere_params = {**params, "vote_count.gte": str(VOTE_FLOOR)}
                pools = Pools(
                    pools.owned,
                    pools.streaming,
                    anywhere=await _discover(
                        db, household_id, client, anywhere_params, filters, page_rng, certs
                    ),
                )
                out = roll(pools)
        except Unavailable:
            unavailable = True
    out = [
        await _with_providers(db, client, c, home) if c.source == "streaming" else c for c in out
    ]
    return Roll(out, cap, unavailable)
