"""Nights: create, night code, shortlist, open/close voting, close, history (03-backend.md).

Every mutation is host-only (`sessions:run`) and CSRF-protected. The snapshot and history
are readable by any device or account of the household. Another household's night is a
404. The tie-break seed is `secrets.randbits(64)`; only when ENVIRONMENT=test may a
caller pin it with the `X-FNH-Test-Seed` header (07-cicd.md), which is not in the contract.
"""

from __future__ import annotations

import secrets
import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.tmdb import Tmdb
from app.core.config import settings
from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentViewer,
    ViewerDb,
    require_permission,
)
from app.domain.voting.base import MAX_SEED
from app.schemas.sessions import (
    AttributionOut,
    CandidateOut,
    GenerateIn,
    GenerateOut,
    NightCodeOut,
    NightSummaryOut,
    OptionIn,
    OptionOut,
    PlacementOut,
    ReorderIn,
    SessionCreatedOut,
    SessionCreateIn,
    SessionOut,
    SessionStatus,
    VotingResultOut,
    WinnerOut,
)
from app.services import generator_service, session_service
from app.services.errors import Conflict, Forbidden, Invalid, NotFound, ServiceError, Unavailable

router = APIRouter(prefix="/sessions", tags=["sessions"])

CanRun = Annotated[AccountContext, Depends(require_permission("sessions:run"))]

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such night (or option/movie) in this household"}
}
EDIT: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    409: {"description": "Not allowed in the night's current state"},
}


def raise_http(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(err) or "Night not found") from None
    if isinstance(err, Forbidden):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This phone can't vote as them") from None
    if isinstance(err, Invalid):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    if isinstance(err, Unavailable):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, err.reason) from None
    raise err  # pragma: no cover


async def _out(db: AsyncSession, household_id: uuid.UUID, session_id: uuid.UUID) -> SessionOut:
    try:
        snap = await session_service.snapshot(db, household_id, session_id)
    except NotFound as err:
        raise_http(err)
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
        result=_result(snap.result),
    )


def _result(result: session_service.VotingResult | None) -> VotingResultOut | None:
    if result is None:
        return None
    return VotingResultOut(
        winner_option_id=result.winner_option_id,
        tie_seed=str(result.tie_seed),
        tie_group=result.tie_group,
        tiebreak=result.tiebreak,
        ballot_count=result.ballot_count,
        placements=[
            PlacementOut(
                option_id=p.option_id, place=p.place, score=p.score, first_places=p.first_places
            )
            for p in result.placements
        ],
    )


def tie_seed(test_seed: str | None) -> int:
    """`secrets.randbits(64)`, unless ENVIRONMENT=test and the caller pinned one."""
    if test_seed is None or settings.ENVIRONMENT != "test":
        return secrets.randbits(64)
    try:
        seed = int(test_seed)
    except ValueError:
        seed = -1
    if not 0 <= seed <= MAX_SEED:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Bad test seed")
    return seed


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


DEFAULT_HISTORY: list[SessionStatus] = ["revealed", "tonight", "closed"]


@router.get("", response_model=list[NightSummaryOut])
async def list_sessions(
    viewer: CurrentViewer,
    db: ViewerDb,
    status_: Annotated[list[SessionStatus] | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[NightSummaryOut]:
    """Nights newest first: winner, date and turnout. Defaults to revealed, tonight and
    closed; `status` may repeat. A winner appears only once a night is revealed."""
    nights = await session_service.history(
        db, viewer.household_id, list(status_ or DEFAULT_HISTORY), limit
    )
    return [
        NightSummaryOut(
            id=n.id,
            title=n.title,
            status=n.status,
            created_at=n.created_at,
            revealed_at=n.revealed_at,
            closed_at=n.closed_at,
            winner=None
            if n.winner is None
            else WinnerOut(
                option_id=n.winner.option_id,
                movie_id=n.winner.movie_id,
                title=n.winner.title,
                year=n.winner.year,
                poster_path=n.winner.poster_path,
            ),
            turnout=n.turnout,
        )
        for n in nights
    ]


@router.get("/{session_id}", response_model=SessionOut, responses=NOT_FOUND)
async def get_session(session_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb) -> SessionOut:
    """The night as every screen sees it. Never ballots; `result` only from reveal on."""
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
        raise_http(err)
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
        movie_id=body.movie_id,
        tmdb_id=body.tmdb_id,
        title=body.title,
        year=body.year,
        source=body.source,
    )
    try:
        await session_service.add_option(
            db, account.household_id, account.account_id, session_id, choice, client
        )
    except ServiceError as err:
        raise_http(err)
    return await _out(db, account.household_id, session_id)


@router.post(
    "/{session_id}/generate",
    response_model=GenerateOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def generate_candidates(
    session_id: uuid.UUID,
    body: GenerateIn,
    account: CanRun,
    db: AccountDb,
    client: Tmdb,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> GenerateOut:
    """Roll candidates for a draft night (ADR-0007): owned titles first, then the
    household's streaming services, then anywhere on TMDB. Nothing is added: the host adds
    picks through POST .../options (`movie_id` for owned, else `tmdb_id` + `source`).
    With TMDB off or down, owned titles still roll and `tmdb_unavailable` is true."""
    req = generator_service.GenerateInput(
        count=body.count,
        genre=body.genre,
        max_runtime=body.max_runtime,
        **({"age_cap": body.age_cap} if "age_cap" in body.model_fields_set else {}),
    )
    try:
        roll = await generator_service.generate(
            db, account.household_id, session_id, req, client, seed=tie_seed(x_fnh_test_seed)
        )
    except ServiceError as err:
        raise_http(err)
    streaming = any(c.source == "streaming" for c in roll.candidates)
    return GenerateOut(
        candidates=[
            CandidateOut(
                movie_id=c.title.movie_id if c.source == "owned" else None,
                tmdb_id=c.title.tmdb_id,
                title=c.title.title,
                year=c.title.year,
                poster_path=c.title.poster_path,
                source=c.source,
                us_cert=c.title.us_cert,
                runtime=c.title.runtime,
                providers=list(c.title.providers),
            )
            for c in roll.candidates
        ],
        age_cap=roll.age_cap,
        tmdb_unavailable=roll.tmdb_unavailable,
        attribution=AttributionOut(
            tmdb=generator_service.TMDB_NOTICE,
            justwatch=generator_service.JUSTWATCH_NOTICE if streaming else None,
        ),
    )


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
        raise_http(err)
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
        raise_http(err)
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
        raise_http(err)
    return await _out(db, account.household_id, session_id)


@router.post(
    "/{session_id}/close-voting",
    response_model=SessionOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def close_voting(
    session_id: uuid.UUID,
    account: CanRun,
    db: AccountDb,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> SessionOut:
    """voting -> revealed: tally, tie-break, store the ranking and winner. Idempotent: a
    repeat returns the stored result unchanged."""
    try:
        await session_service.close_voting(
            db,
            account.household_id,
            account.account_id,
            session_id,
            seed=tie_seed(x_fnh_test_seed),
        )
    except ServiceError as err:
        raise_http(err)
    return await _out(db, account.household_id, session_id)


@router.post(
    "/{session_id}/close",
    response_model=SessionOut,
    dependencies=[CsrfProtected],
    responses=EDIT,
)
async def close_night(session_id: uuid.UUID, account: CanRun, db: AccountDb) -> SessionOut:
    """tonight -> closed: the night code stops joining. Idempotent."""
    try:
        await session_service.close(db, account.household_id, account.account_id, session_id)
    except ServiceError as err:
        raise_http(err)
    return await _out(db, account.household_id, session_id)
