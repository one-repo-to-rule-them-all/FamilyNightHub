"""Ratings (03-backend.md "Ratings").

After the movie each person scores it 1–5. A phone rates as a person actively bound to it;
a host with `ballots:proxy` rates for anyone (kids without phones). Rating again replaces
the score. Allowed once the night is `tonight` (a settled reveal counts) or `closed`. A
phone reads back its own people's scores; everyone else sees only the family average on
the snapshot and in history. Only someone who took part in the night (present or voted) may
rate it: anyone else gets 403 `not_attended`, and `/ratings/mine` says who may.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.sessions import raise_http
from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentDevice,
    DeviceDb,
    require_permission,
)
from app.schemas.sessions import OwnRatingOut, RatingIn
from app.services import rating_service
from app.services.errors import Forbidden, NotAttended, ServiceError

router = APIRouter(prefix="/sessions/{session_id}", tags=["ratings"])

CanProxy = Annotated[AccountContext, Depends(require_permission("ballots:proxy"))]

RATE: dict[int | str, dict[str, Any]] = {
    403: {
        "description": "This phone isn't (actively) bound to that person, or (code "
        "`not_attended`) that person didn't take part in the night"
    },
    404: {"description": "No such night (or person) in this household"},
    409: {"description": "Ratings are not open yet"},
}


class NotAttendedError(HTTPException):
    """403 `not_attended`: only someone who took part in a night may rate it (issue #91)."""

    code = "not_attended"

    def __init__(self, reason: str) -> None:
        super().__init__(status.HTTP_403_FORBIDDEN, reason)


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotAttended):
        raise NotAttendedError(err.reason or "") from None
    if isinstance(err, Forbidden):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, err.reason or "This phone can't rate as them"
        ) from None
    raise_http(err)


@router.put(
    "/ratings",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=RATE,
)
async def rate(session_id: uuid.UUID, body: RatingIn, device: CurrentDevice, db: DeviceDb) -> None:
    """Set or replace the score of a person bound to this phone."""
    try:
        await rating_service.rate(
            db,
            device.household_id,
            session_id,
            body.person_id,
            body.score,
            device_id=device.device_id,
        )
    except ServiceError as err:
        _raise(err)


@router.put(
    "/ratings/proxy",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=RATE,
)
async def rate_proxy(
    session_id: uuid.UUID, body: RatingIn, account: CanProxy, db: AccountDb
) -> None:
    """Host rates on someone's behalf (audited as `rating.proxy_rated`)."""
    try:
        await rating_service.rate(
            db,
            account.household_id,
            session_id,
            body.person_id,
            body.score,
            proxy_account_id=account.account_id,
        )
    except ServiceError as err:
        _raise(err)


@router.get(
    "/ratings/mine",
    response_model=list[OwnRatingOut],
    responses={404: {"description": "No such night in this household"}},
)
async def my_ratings(
    session_id: uuid.UUID, device: CurrentDevice, db: DeviceDb
) -> list[OwnRatingOut]:
    """Scores of the people actively bound to this phone (null until each has rated), and
    whether each took part in the night (`attended`: only they may rate it)."""
    try:
        ratings = await rating_service.own_ratings(
            db, device.household_id, device.device_id, session_id
        )
    except ServiceError as err:
        _raise(err)
    return [
        OwnRatingOut(person_id=r.person_id, score=r.score, attended=r.attended) for r in ratings
    ]
