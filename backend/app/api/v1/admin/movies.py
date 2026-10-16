"""The movie library (`admin:movies`): browse and flag titles, bulk-add owned ones
(ADR-0007). 03-backend.md "Library and history admin"."""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.v1.tmdb import Tmdb
from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.schemas.library import (
    AdminMovieOut,
    BulkAddIn,
    BulkConfirmIn,
    BulkLineOut,
    BulkResultOut,
    MovieFlagsIn,
    MoviePageOut,
)
from app.schemas.sessions import TmdbResultOut
from app.services import library_service
from app.services.errors import NotFound
from app.services.generator_service import TMDB_NOTICE

router = APIRouter(prefix="/movies", tags=["admin"])

CanManageMovies = Annotated[AccountContext, Depends(require_permission("admin:movies"))]

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such movie in this household"}
}


def _movie(m: library_service.LibraryMovie) -> AdminMovieOut:
    return AdminMovieOut(
        id=m.id,
        tmdb_id=m.tmdb_id,
        title=m.title,
        year=m.year,
        poster_path=m.poster_path,
        owned=m.owned,
        watchlist=m.watchlist,
        blocked=m.blocked,
        created_at=m.created_at,
    )


def _bulk(result: library_service.BulkResult) -> BulkResultOut:
    return BulkResultOut(
        lines=[
            BulkLineOut(
                title=line.title,
                year=line.year,
                status=line.status,
                movie=None if line.movie is None else _movie(line.movie),
                already_owned=line.already_owned,
                candidates=[
                    TmdbResultOut(
                        tmdb_id=c.tmdb_id, title=c.title, year=c.year, poster_path=c.poster_path
                    )
                    for c in line.candidates
                ],
            )
            for line in result.lines
        ],
        tmdb_unavailable=result.tmdb_unavailable,
        attribution=TMDB_NOTICE,
    )


@router.get("", response_model=MoviePageOut)
async def list_movies(
    account: CanManageMovies,
    db: AccountDb,
    q: Annotated[str | None, Query(max_length=100)] = None,
    owned: bool | None = None,
    watchlist: bool | None = None,
    blocked: bool | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> MoviePageOut:
    """The household's library, alphabetical. `q` searches titles; each flag filter is
    optional (left out = either)."""
    page = await library_service.list_movies(
        db,
        account.household_id,
        q=q,
        owned=owned,
        watchlist=watchlist,
        blocked=blocked,
        limit=limit,
        offset=offset,
    )
    return MoviePageOut(
        items=[_movie(m) for m in page.items], total=page.total, limit=limit, offset=offset
    )


@router.post("/bulk", response_model=BulkResultOut, dependencies=[CsrfProtected])
async def bulk_add(
    body: BulkAddIn, account: CanManageMovies, db: AccountDb, client: Tmdb
) -> BulkResultOut:
    """Resolve typed titles through TMDB search and mark the matches owned. Ambiguous lines
    come back with candidates for `/bulk/confirm`. If TMDB is off or down, the remaining
    lines are added as typed titles (`added_manual`) and `tmdb_unavailable` is true."""
    titles = [library_service.TypedTitle(t.title, t.year) for t in body.titles]
    return _bulk(
        await library_service.bulk_add(db, account.household_id, account.account_id, client, titles)
    )


@router.post("/bulk/confirm", response_model=BulkResultOut, dependencies=[CsrfProtected])
async def bulk_confirm(
    body: BulkConfirmIn, account: CanManageMovies, db: AccountDb, client: Tmdb
) -> BulkResultOut:
    """The admin's picks for ambiguous lines (a `tmdb_id`) or "add as typed" (none)."""
    picks = [library_service.TypedTitle(p.title, p.year, p.tmdb_id) for p in body.picks]
    return _bulk(
        await library_service.confirm(db, account.household_id, account.account_id, client, picks)
    )


@router.patch(
    "/{movie_id}", response_model=AdminMovieOut, dependencies=[CsrfProtected], responses=NOT_FOUND
)
async def update_movie(
    movie_id: uuid.UUID, body: MovieFlagsIn, account: CanManageMovies, db: AccountDb
) -> AdminMovieOut:
    """Set owned / watchlist / blocked; flags left out are unchanged."""
    try:
        movie = await library_service.update_flags(
            db,
            account.household_id,
            account.account_id,
            movie_id,
            body.model_dump(exclude_none=True),
        )
    except NotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Movie not found") from None
    return _movie(movie)
