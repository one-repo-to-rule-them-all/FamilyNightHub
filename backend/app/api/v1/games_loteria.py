"""Loteria routes (ADR-0018 amendment 2026-11-26), mounted under `/games`.

Hosts (`sessions:run`) open, start, draw and check. A phone joins, rerolls its tabla while the
game is open and marks called pictures as a person bound to it. Cards live in `bingo_cards`,
calls in `bingo_calls`; the snapshot (`GET /games/{id}`) never holds the seed or a future call.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Header, Path, Query

from app.api.v1.games import HOST, PLAYER, CanHost, snapshot
from app.api.v1.sessions import NOT_FOUND, raise_http, tie_seed
from app.core.dependencies import AccountDb, CsrfProtected, CurrentDevice, DeviceDb
from app.schemas.games import (
    GameOut,
    LoteriaCheckIn,
    LoteriaCheckOut,
    LoteriaDrawIn,
    LoteriaJoinIn,
    LoteriaTablaOut,
)
from app.services import loteria_service
from app.services.errors import ServiceError

router = APIRouter(prefix="/games", tags=["games"])

Square = Annotated[int, Path(ge=0, le=15)]
TestSeed = Annotated[str | None, Header(include_in_schema=False)]


def _out(t: loteria_service.Tabla) -> LoteriaTablaOut:
    return LoteriaTablaOut(**t.__dict__)


@router.post(
    "/{game_id}/loteria/open", response_model=GameOut, dependencies=[CsrfProtected], responses=HOST
)
async def open_loteria(
    game_id: uuid.UUID, account: CanHost, db: AccountDb, x_fnh_test_seed: TestSeed = None
) -> GameOut:
    """Let the family join (draft to open). Fixes the draw seed."""
    try:
        await loteria_service.open_game(
            db,
            account.household_id,
            account.account_id,
            game_id,
            seed=tie_seed(x_fnh_test_seed),
        )
    except ServiceError as err:
        raise_http(err)
    return await snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/loteria/start", response_model=GameOut, dependencies=[CsrfProtected], responses=HOST
)
async def start_loteria(game_id: uuid.UUID, account: CanHost, db: AccountDb) -> GameOut:
    """Start the round: cards can be drawn and marked, tablas are fixed (open to live)."""
    try:
        await loteria_service.start_round(db, account.household_id, account.account_id, game_id)
    except ServiceError as err:
        raise_http(err)
    return await snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/loteria/join",
    response_model=LoteriaTablaOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def join_loteria(
    game_id: uuid.UUID,
    body: LoteriaJoinIn,
    device: CurrentDevice,
    db: DeviceDb,
    x_fnh_test_seed: TestSeed = None,
) -> LoteriaTablaOut:
    """Take a seat as a person bound to this phone and get a tabla (idempotent)."""
    try:
        tabla = await loteria_service.join(
            db,
            device.household_id,
            game_id,
            device_id=device.device_id,
            person_id=body.person_id,
            seed=tie_seed(x_fnh_test_seed),
        )
    except ServiceError as err:
        raise_http(err)
    return _out(tabla)


@router.post(
    "/{game_id}/loteria/reroll",
    response_model=LoteriaTablaOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def reroll_loteria(
    game_id: uuid.UUID,
    body: LoteriaJoinIn,
    device: CurrentDevice,
    db: DeviceDb,
    x_fnh_test_seed: TestSeed = None,
) -> LoteriaTablaOut:
    """A new tabla, as often as you like while the game is open; 409 once it has started."""
    try:
        tabla = await loteria_service.reroll(
            db,
            device.household_id,
            game_id,
            device_id=device.device_id,
            person_id=body.person_id,
            seed=tie_seed(x_fnh_test_seed),
        )
    except ServiceError as err:
        raise_http(err)
    return _out(tabla)


@router.get("/{game_id}/loteria/mine", response_model=list[LoteriaTablaOut], responses=NOT_FOUND)
async def my_tablas(
    game_id: uuid.UUID, device: CurrentDevice, db: DeviceDb
) -> list[LoteriaTablaOut]:
    """The tablas of the people this phone is acting as. Nobody else's is readable."""
    try:
        tablas = await loteria_service.my_tablas(db, device.household_id, game_id, device.device_id)
    except ServiceError as err:
        raise_http(err)
    return [_out(t) for t in tablas]


async def _mark(
    game_id: uuid.UUID, index: int, person_id: uuid.UUID, device: Any, db: Any, marked: bool
) -> LoteriaTablaOut:
    try:
        tabla = await loteria_service.set_mark(
            db,
            device.household_id,
            game_id,
            index,
            device_id=device.device_id,
            person_id=person_id,
            marked=marked,
        )
    except ServiceError as err:
        raise_http(err)
    return _out(tabla)


@router.put(
    "/{game_id}/loteria/mark/{index}",
    response_model=LoteriaTablaOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def mark_square(
    game_id: uuid.UUID,
    index: Square,
    person_id: Annotated[uuid.UUID, Query()],
    device: CurrentDevice,
    db: DeviceDb,
) -> LoteriaTablaOut:
    """Mark a picture on your own tabla. Only a called card can be marked (409)."""
    return await _mark(game_id, index, person_id, device, db, True)


@router.delete(
    "/{game_id}/loteria/mark/{index}",
    response_model=LoteriaTablaOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def unmark_square(
    game_id: uuid.UUID,
    index: Square,
    person_id: Annotated[uuid.UUID, Query()],
    device: CurrentDevice,
    db: DeviceDb,
) -> LoteriaTablaOut:
    """Take a mark back. A win already recorded stays."""
    return await _mark(game_id, index, person_id, device, db, False)


@router.post(
    "/{game_id}/loteria/draw", response_model=GameOut, dependencies=[CsrfProtected], responses=HOST
)
async def draw_card(
    game_id: uuid.UUID, body: LoteriaDrawIn, account: CanHost, db: AccountDb
) -> GameOut:
    """Call the next card (hosts). `expected_seq` is the count the host's screen showed; a
    different count is 409 so a double tap or a second window cannot draw twice."""
    try:
        await loteria_service.draw(
            db, account.household_id, account.account_id, game_id, expected_seq=body.expected_seq
        )
    except ServiceError as err:
        raise_http(err)
    return await snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/loteria/check",
    response_model=LoteriaCheckOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def check_loteria(
    game_id: uuid.UUID, body: LoteriaCheckIn, account: CanHost, db: AccountDb
) -> LoteriaCheckOut:
    """Verify a player's spoken "Loteria!" against the called cards (hosts). A false claim
    changes nothing; a true one records the win and, by config, ends the game."""
    try:
        result = await loteria_service.check(
            db, account.household_id, account.account_id, game_id, person_id=body.person_id
        )
    except ServiceError as err:
        raise_http(err)
    return LoteriaCheckOut(
        valid=result.valid,
        pattern=result.pattern,
        squares=result.squares,
        missing=result.missing,
    )
