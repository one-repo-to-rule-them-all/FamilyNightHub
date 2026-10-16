"""TMDB search proxy for hosts building a shortlist (03-backend.md "Candidates").

The browser never talks to TMDB: the read token is server-only. 503 means TMDB is not
configured or is down; the shortlist still takes a typed title.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import AccountContext, AccountDb, require_permission
from app.integrations.tmdb import TmdbClient, configured_client
from app.schemas.sessions import TmdbResultOut
from app.services import movie_service
from app.services.errors import Unavailable

router = APIRouter(prefix="/tmdb", tags=["movies"])

CanRun = Annotated[AccountContext, Depends(require_permission("sessions:run"))]


def tmdb_client() -> TmdbClient | None:
    """Overridable in tests (app.dependency_overrides) to point at the fake."""
    return configured_client()


Tmdb = Annotated[TmdbClient | None, Depends(tmdb_client)]


@router.get(
    "/search",
    response_model=list[TmdbResultOut],
    responses={503: {"description": "TMDB not configured or unavailable"}},
)
async def search(
    account: CanRun, db: AccountDb, client: Tmdb, q: str = Query(min_length=1, max_length=100)
) -> list[TmdbResultOut]:
    try:
        movies = await movie_service.search(db, client, q)
    except Unavailable as err:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, err.reason) from None
    return [
        TmdbResultOut(tmdb_id=m.tmdb_id, title=m.title, year=m.year, poster_path=m.poster_path)
        for m in movies
    ]
