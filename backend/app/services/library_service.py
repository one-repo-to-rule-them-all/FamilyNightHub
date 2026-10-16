"""The household's movie library for admins: browse, flag, and bulk-add owned titles
(ADR-0007: "The owned library must be seeded before the generator is useful").

Bulk add resolves each typed line through TMDB search (through the global cache, so a
re-paste costs nothing) and `domain/library.classify`. Matches are upserted with
`owned = true`; ambiguous lines come back with their top candidates for the admin to pick
from (`confirm`). If TMDB is off or goes down part-way, the remaining lines are added as
typed titles without a TMDB id rather than failing the paste: an owned title the generator
can roll beats a perfect one it can't. After the first failure no further line calls
TMDB, so a hung TMDB costs one timeout, not one per line.

Every write is audited (`target_type = 'movie'`).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import library
from app.integrations.tmdb import TmdbClient, TmdbMovie
from app.services import movie_service
from app.services.errors import NotFound, Unavailable

LineStatus = Literal["matched", "ambiguous", "not_found", "added_manual"]
FLAGS = ("owned", "watchlist", "blocked")


@dataclass(frozen=True)
class LibraryMovie:
    id: uuid.UUID
    tmdb_id: int | None
    title: str
    year: int | None
    poster_path: str | None
    owned: bool
    watchlist: bool
    blocked: bool
    created_at: datetime


@dataclass(frozen=True)
class Page:
    items: list[LibraryMovie]
    total: int


@dataclass(frozen=True)
class TypedTitle:
    title: str
    year: int | None = None
    # Only on confirm: the TMDB pick for an ambiguous line. None = add as typed.
    tmdb_id: int | None = None


@dataclass(frozen=True)
class LineResult:
    title: str
    year: int | None
    status: LineStatus
    movie: LibraryMovie | None = None
    # True when the title was already marked owned before this paste.
    already_owned: bool = False
    candidates: list[TmdbMovie] = field(default_factory=list)


@dataclass(frozen=True)
class BulkResult:
    lines: list[LineResult]
    tmdb_unavailable: bool


_COLUMNS = "id, tmdb_id, title, year, poster_path, owned, watchlist, blocked, created_at"


def _movie(r: Any) -> LibraryMovie:
    return LibraryMovie(
        r.id,
        r.tmdb_id,
        r.title,
        r.year,
        r.poster_path,
        r.owned,
        r.watchlist,
        r.blocked,
        r.created_at,
    )


async def _audit(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    movie_id: uuid.UUID | None,
    data: dict[str, Any],
) -> None:
    await db.execute(
        text(
            "INSERT INTO audit_events (household_id, actor_account_id, action, target_type, "
            "target_id, data) VALUES (:h, :a, :action, 'movie', :m, CAST(:data AS jsonb))"
        ),
        {
            "h": household_id,
            "a": account_id,
            "action": action,
            "m": movie_id,
            "data": json.dumps(data),
        },
    )


def _like(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_movies(
    db: AsyncSession,
    household_id: uuid.UUID,
    *,
    q: str | None,
    owned: bool | None,
    watchlist: bool | None,
    blocked: bool | None,
    limit: int,
    offset: int,
) -> Page:
    """Title search plus flag filters (None = either), alphabetical, paginated."""
    where = ["household_id = :h"]
    params: dict[str, Any] = {"h": household_id, "limit": limit, "offset": offset}
    query = " ".join((q or "").split())
    if query:
        where.append("title ILIKE :q ESCAPE '\\'")
        params["q"] = _like(query)
    for name, value in (("owned", owned), ("watchlist", watchlist), ("blocked", blocked)):
        if value is not None:
            where.append(f"{name} = :{name}")
            params[name] = value
    clause = " AND ".join(where)
    total: int = await db.scalar(text(f"SELECT count(*) FROM movies WHERE {clause}"), params)
    rows = await db.execute(
        text(
            f"SELECT {_COLUMNS} FROM movies WHERE {clause} "
            "ORDER BY lower(title), year NULLS LAST, id LIMIT :limit OFFSET :offset"
        ),
        params,
    )
    return Page([_movie(r) for r in rows], total)


async def _get(db: AsyncSession, household_id: uuid.UUID, movie_id: uuid.UUID) -> LibraryMovie:
    row = (
        await db.execute(
            text(f"SELECT {_COLUMNS} FROM movies WHERE id = :m AND household_id = :h FOR UPDATE"),
            {"m": movie_id, "h": household_id},
        )
    ).first()
    if row is None:
        raise NotFound
    return _movie(row)


async def update_flags(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    movie_id: uuid.UUID,
    changes: dict[str, bool],
) -> LibraryMovie:
    """Set any of owned/watchlist/blocked; flags left out are unchanged. Audited with
    from/to for the flags that actually changed (none changed → no audit row)."""
    before = await _get(db, household_id, movie_id)
    diff = {
        name: {"from": getattr(before, name), "to": value}
        for name, value in changes.items()
        if name in FLAGS and getattr(before, name) != value
    }
    if not diff:
        return before
    sets = ", ".join(f"{name} = :{name}" for name in diff)
    row = (
        await db.execute(
            text(f"UPDATE movies SET {sets} WHERE id = :m RETURNING {_COLUMNS}"),
            {"m": movie_id, **{name: d["to"] for name, d in diff.items()}},
        )
    ).one()
    await _audit(db, household_id, account_id, "movie.updated", movie_id, diff)
    return _movie(row)


async def _mark_owned(db: AsyncSession, movie_id: uuid.UUID) -> tuple[LibraryMovie, bool]:
    """Set owned on the movie; returns it and whether it was owned already."""
    was_owned: bool = await db.scalar(
        text("SELECT owned FROM movies WHERE id = :m FOR UPDATE"), {"m": movie_id}
    )
    row = (
        await db.execute(
            text(f"UPDATE movies SET owned = true WHERE id = :m RETURNING {_COLUMNS}"),
            {"m": movie_id},
        )
    ).one()
    return _movie(row), was_owned


class _Tmdb:
    """The request's TMDB access: goes quiet for the rest of the request after a failure."""

    def __init__(self, client: TmdbClient | None) -> None:
        self.client = client
        self.down = client is None

    async def search(self, db: AsyncSession, title: str) -> list[TmdbMovie] | None:
        if self.down:
            return None
        try:
            return await movie_service.search(db, self.client, title)
        except Unavailable:
            self.down = True
            return None

    async def upsert(
        self, db: AsyncSession, household_id: uuid.UUID, tmdb_id: int
    ) -> uuid.UUID | None:
        """The household's movie for a TMDB id; None if TMDB is down and it isn't stored
        yet. NotFound if TMDB says the id doesn't exist."""
        try:
            return await movie_service.upsert_from_tmdb(
                db, household_id, None if self.down else self.client, tmdb_id
            )
        except Unavailable:
            self.down = True
            return None


async def _owned_line(
    db: AsyncSession, typed: TypedTitle, movie_id: uuid.UUID, status: LineStatus
) -> LineResult:
    movie, was_owned = await _mark_owned(db, movie_id)
    return LineResult(typed.title, typed.year, status, movie, already_owned=was_owned)


async def _add_typed(db: AsyncSession, household_id: uuid.UUID, typed: TypedTitle) -> LineResult:
    movie_id = await movie_service.upsert_manual(db, household_id, typed.title, typed.year)
    return await _owned_line(db, typed, movie_id, "added_manual")


async def _summarize(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    action: str,
    lines: list[LineResult],
    tmdb: _Tmdb,
) -> BulkResult:
    counts: dict[str, Any] = {s: 0 for s in ("matched", "ambiguous", "not_found", "added_manual")}
    for line in lines:
        counts[line.status] += 1
    newly_owned = [str(x.movie.id) for x in lines if x.movie is not None and not x.already_owned]
    if newly_owned:
        await _audit(
            db,
            household_id,
            account_id,
            action,
            None,
            {**counts, "movie_ids": newly_owned, "tmdb_unavailable": tmdb.down},
        )
    return BulkResult(lines, tmdb.down)


async def bulk_add(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    client: TmdbClient | None,
    titles: list[TypedTitle],
) -> BulkResult:
    tmdb = _Tmdb(client)
    lines: list[LineResult] = []
    for typed in titles:
        results = await tmdb.search(db, typed.title)
        if results is None:
            lines.append(await _add_typed(db, household_id, typed))
            continue
        match = library.classify(typed.title, typed.year, results)
        if match.verdict != "matched":
            lines.append(
                LineResult(typed.title, typed.year, match.verdict, candidates=list(match.picks))
            )
            continue
        movie_id = await tmdb.upsert(db, household_id, match.picks[0].tmdb_id)
        if movie_id is None:
            lines.append(await _add_typed(db, household_id, typed))
        else:
            lines.append(await _owned_line(db, typed, movie_id, "matched"))
    return await _summarize(db, household_id, account_id, "movie.bulk_added", lines, tmdb)


async def confirm(
    db: AsyncSession,
    household_id: uuid.UUID,
    account_id: uuid.UUID,
    client: TmdbClient | None,
    picks: list[TypedTitle],
) -> BulkResult:
    """The admin's answers for ambiguous / not-found lines: a TMDB id to use, or none to add
    the title as typed. A pick TMDB can't fetch because it is down is added as typed."""
    tmdb = _Tmdb(client)
    lines: list[LineResult] = []
    for typed in picks:
        if typed.tmdb_id is None:
            lines.append(await _add_typed(db, household_id, typed))
            continue
        try:
            movie_id = await tmdb.upsert(db, household_id, typed.tmdb_id)
        except NotFound:
            lines.append(LineResult(typed.title, typed.year, "not_found"))
            continue
        if movie_id is None:
            lines.append(await _add_typed(db, household_id, typed))
        else:
            lines.append(await _owned_line(db, typed, movie_id, "matched"))
    return await _summarize(db, household_id, account_id, "movie.bulk_confirmed", lines, tmdb)
