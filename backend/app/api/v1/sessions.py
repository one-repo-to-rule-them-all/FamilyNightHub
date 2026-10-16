"""Nights: create, night code, shortlist, open voting, snapshot (03-backend.md "Voting").

Every mutation is host-only (`sessions:run`) and CSRF-protected. The snapshot is readable
by any device or account of the household. Another household's night is a 404.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.tmdb import Tmdb
from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentViewer,
    ViewerDb,
    require_permission,
)
from app.schemas.sessions import (
    NightCodeOut,
    OptionIn,
    OptionOut,
    ReorderIn,
    SessionCreatedOut,
    SessionCreateIn,
    SessionOut,
)
from app.services import session_service
from app.services.errors import Conflict, NotFound, ServiceError, Unavailable

router = APIRouter(prefix="/sessions", tags=["sessions"])

CanRun = Annotated[AccountContext, Depends(require_permission("sessions:run"))]

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such night (or option/movie) in this household"}
}
EDIT: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    409: {"description": "Not allowed in the night's current state"},
}


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err) or "Night not found") from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    if isinstance(err, Unavailable):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, err.reason) from None
    raise err  # pragma: no cover


async def _out(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> SessionOut:
    try:
        snap = await session_service.snapshot(db, household_id, session_id)
    except NotFound as err:
        _raise(err)
    return SessionOut(
        id=snap.id,
        title=snap.title,
        status=snap.status,
        voting_method=snap.voting_method,
        ballot_size=snap.ballot_size,
        options=[
            OptionOut(
                id=o.id,
                movie_id=o.movie_id,
                title=o.title,
                year=o.year,
                poster_path=o.poster_path,
                source=o.source,
                position=o.position,
            )
            for o in snap.options
        ],
        created_at=snap.created_at,
        voting_opened_at=snap.voting_opened_at,
        revealed_at=snap.revealed_at,
        closed_at=snap.closed_at,
    )


@router.post(
    "",
    response_model=SessionCreatedOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
)
async def create_session(
    body: SessionCreateIn, account: CanRun, db: AccountDb
) -> SessionCreatedOut:
    """Start a night in `draft`. The night code is in this response and nowhere else."""
    created = await session_service.create(
        db, account.household_id, account.account_id, title=body.title
    )
    return SessionCreatedOut(session_id=created.session_id, night_code=created.night_code)


@router.get("/{session_id}", response_model=SessionOut, responses=NOT_FOUND)
async def get_session(session_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb) -> SessionOut:
    """The night as every screen sees it. Never ballots or tallies."""
    return await _out(db, viewer.household_id, session_id)


@router.post(
    "/{session_id}/night-code",
    response_model=NightCodeOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def rotate_night_code(session_id: uuid.UUID, account: CanRun, db: AccountDb) -> NightCodeOut:
    """Replace the code (lost, or leaked beyond the room). The old one stops working."""
    try:
        code = await session_service.rotate_code(
            db, account.household_id, account.account_id, session_id
        )
    except ServiceError as err:
        _raise(err)
    return NightCodeOut(night_code=code)


@router.post(
    "/{session_id}/options",
    response_model=SessionOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={**EDIT, 503: {"description": "TMDB not configured or unavailable"}},
)
async def add_option(
    session_id: uuid.UUID, body: OptionIn, account: CanRun, db: AccountDb, client: Tmdb
) -> SessionOut:
    choice = session_service.OptionInput(
        movie_id=body.movie_id, tmdb_id=body.tmdb_id, title=body.title, year=body.year
    )
    try:
        await session_service.add_option(
            db, account.household_id, account.account_id, session_id, choice, client
        )
    except ServiceError as err:
        _raise(err)
    return await _out(db, account.household_id, session_id)


@router.delete(
    "/{session_id}/options/{option_id}",
    response_model=SessionOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def remove_option(
    session_id: uuid.UUID, option_id: uuid.UUID, account: CanRun, db: AccountDb
) -> SessionOut:
    try:
        await session_service.remove_option(
            db, account.household_id, account.account_id, session_id, option_id
        )
    except ServiceError as err:
        _raise(err)
    return await _out(db, account.household_id, session_id)


@router.put(
    "/{session_id}/options/order",
    response_model=SessionOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def reorder_options(
    session_id: uuid.UUID, body: ReorderIn, account: CanRun, db: AccountDb
) -> SessionOut:
    """Set the display order: `option_ids` must list every option exactly once."""
    try:
        await session_service.reorder(
            db, account.household_id, account.account_id, session_id, body.option_ids
        )
    except ServiceError as err:
        _raise(err)
    return await _out(db, account.household_id, session_id)


@router.post(
    "/{session_id}/open-voting",
    response_model=SessionOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def open_voting(session_id: uuid.UUID, account: CanRun, db: AccountDb) -> SessionOut:
    """draft -> voting. Needs 2..8 options; fixes ballot_size = min(3, n - 1)."""
    try:
        await session_service.open_voting(db, account.household_id, account.account_id, session_id)
    except ServiceError as err:
        _raise(err)
    return await _out(db, account.household_id, session_id)
