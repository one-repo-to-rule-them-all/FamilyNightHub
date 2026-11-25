"""Thanksgiving Scattergories routes (ADR-0018 slice C), mounted under `/games`.

Hosts (`sessions:run`) draw and start a round, reveal and override a verdict. A phone joins and
submits answers as a person bound to it. The snapshot (`GET /games/{id}`) carries the timer as
`ends_at` + `server_now`; there are no tick events. It never holds an answer before reveal.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Query, status

from app.api.v1.games import HOST, PLAYER, CanHost, snapshot
from app.api.v1.sessions import NOT_FOUND, raise_http, tie_seed
from app.core.dependencies import AccountDb, CsrfProtected, CurrentDevice, DeviceDb
from app.schemas.games import (
    GameOut,
    ScatterDrawOut,
    ScatterJoinIn,
    ScatterOwnAnswerOut,
    ScatterReviewOut,
    ScatterRoundIn,
    ScatterSubmitIn,
    ScatterVerdictIn,
)
from app.services import scatter_service
from app.services.errors import ServiceError

router = APIRouter(prefix="/games", tags=["games"])


@router.get("/{game_id}/scatter/draw", response_model=ScatterDrawOut, responses=NOT_FOUND)
async def draw(
    game_id: uuid.UUID,
    account: CanHost,
    db: AccountDb,
    count: Annotated[int, Query(ge=1, le=12)] = 6,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> ScatterDrawOut:
    """A themed draw of categories for the host to edit before starting. Nothing is stored."""
    try:
        cats = await scatter_service.draw_categories(
            db, account.household_id, game_id, count=count, seed=tie_seed(x_fnh_test_seed)
        )
    except ServiceError as err:
        raise_http(err)
    return ScatterDrawOut(categories=cats)


@router.post(
    "/{game_id}/scatter/rounds",
    response_model=GameOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={**HOST, 422: {"description": "Bad categories or duration"}},
)
async def start_round(
    game_id: uuid.UUID,
    body: ScatterRoundIn,
    account: CanHost,
    db: AccountDb,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> GameOut:
    """Start the next round: a random letter, the given (or drawn) categories, a duration."""
    try:
        await scatter_service.start_round(
            db,
            account.household_id,
            account.account_id,
            game_id,
            seed=tie_seed(x_fnh_test_seed),
            categories=body.categories,
            count=body.count,
            duration_seconds=body.duration_seconds,
        )
    except ServiceError as err:
        raise_http(err)
    return await snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/scatter/reveal",
    response_model=GameOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def reveal(game_id: uuid.UUID, account: CanHost, db: AccountDb) -> GameOut:
    """Show every answer on every screen and freeze them (ends the round early if running)."""
    try:
        await scatter_service.reveal(db, account.household_id, account.account_id, game_id)
    except ServiceError as err:
        raise_http(err)
    return await snapshot(db, account.household_id, game_id)


@router.get(
    "/{game_id}/scatter/rounds/{round_no}/review",
    response_model=ScatterReviewOut,
    responses={**HOST, 409: {"description": "The round is not revealed yet"}},
)
async def review(
    game_id: uuid.UUID, round_no: int, account: CanHost, db: AccountDb
) -> ScatterReviewOut:
    """Only the answers that need a decision: near-duplicates and very short answers, with
    wrong letters and exact duplicates as information. Everything else counts automatically."""
    try:
        view = await scatter_service.review(db, account.household_id, game_id, round_no)
    except ServiceError as err:
        raise_http(err)
    return ScatterReviewOut.model_validate(view, from_attributes=True)


@router.put(
    "/{game_id}/scatter/answers/{answer_id}/verdict",
    response_model=GameOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def set_verdict(
    game_id: uuid.UUID,
    answer_id: uuid.UUID,
    body: ScatterVerdictIn,
    account: CanHost,
    db: AccountDb,
) -> GameOut:
    """Reject or re-accept an answer after reveal; scores re-derive on the next read."""
    try:
        await scatter_service.set_verdict(
            db, account.household_id, account.account_id, game_id, answer_id, body.verdict
        )
    except ServiceError as err:
        raise_http(err)
    return await snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/scatter/join",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def join(
    game_id: uuid.UUID, body: ScatterJoinIn, device: CurrentDevice, db: DeviceDb
) -> None:
    """Join as a person bound to this phone (idempotent)."""
    try:
        await scatter_service.join(
            db, device.household_id, game_id, device_id=device.device_id, person_id=body.person_id
        )
    except ServiceError as err:
        raise_http(err)


@router.put(
    "/{game_id}/scatter/answers",
    response_model=list[ScatterOwnAnswerOut],
    dependencies=[CsrfProtected],
    responses={**PLAYER, 422: {"description": "A bad category or an over-long answer"}},
)
async def submit(
    game_id: uuid.UUID, body: ScatterSubmitIn, device: CurrentDevice, db: DeviceDb
) -> list[ScatterOwnAnswerOut]:
    """Save or replace answers until time is up (plus a 2 s grace; 409 after). Blank clears."""
    try:
        rows = await scatter_service.submit(
            db,
            device.household_id,
            game_id,
            device_id=device.device_id,
            person_id=body.person_id,
            answers=[(a.category_index, a.text) for a in body.answers],
        )
    except ServiceError as err:
        raise_http(err)
    return [ScatterOwnAnswerOut(**r.__dict__) for r in rows]


@router.get(
    "/{game_id}/scatter/answers/mine",
    response_model=list[ScatterOwnAnswerOut],
    responses=NOT_FOUND,
)
async def my_answers(
    game_id: uuid.UUID, device: CurrentDevice, db: DeviceDb
) -> list[ScatterOwnAnswerOut]:
    """The latest round's answers from the people this phone is acting as."""
    try:
        rows = await scatter_service.own_answers(db, device.household_id, game_id, device.device_id)
    except ServiceError as err:
        raise_http(err)
    return [ScatterOwnAnswerOut(**r.__dict__) for r in rows]
