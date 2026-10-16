"""Ballots (ADR-0006, 03-backend.md "Request lifecycle").

A phone votes as a person actively bound to it; a host with `ballots:proxy` votes for
anyone (kids without phones). Casting replaces that person's ballot and is allowed only
while the night is `voting`. Every screen may see *who* has voted; a phone may read back
the ballots of its own bound people. Nobody reads anyone else's ranks.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from app.api.v1.sessions import raise_http
from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentDevice,
    CurrentViewer,
    DeviceDb,
    ViewerDb,
    require_permission,
)
from app.schemas.sessions import BallotIn, OwnBallotOut, RankOut, VoterOut, VotersOut
from app.services import ballot_service
from app.services.errors import ServiceError

router = APIRouter(prefix="/sessions/{session_id}", tags=["ballots"])

CanProxy = Annotated[AccountContext, Depends(require_permission("ballots:proxy"))]

CAST: dict[int | str, dict[str, Any]] = {
    403: {"description": "This phone isn't (actively) bound to that person"},
    404: {"description": "No such night (or person) in this household"},
    409: {"description": "Voting is not open"},
    422: {"description": "The ranks break the night's ballot rules"},
}


def _ranks(body: BallotIn) -> list[tuple[uuid.UUID, int]]:
    return [(r.option_id, r.rank) for r in body.ranks]


@router.put(
    "/ballots",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=CAST,
)
async def cast_ballot(
    session_id: uuid.UUID, body: BallotIn, device: CurrentDevice, db: DeviceDb
) -> None:
    """Cast or replace the ballot of a person bound to this phone."""
    try:
        await ballot_service.cast(
            db,
            device.household_id,
            session_id,
            body.person_id,
            _ranks(body),
            device_id=device.device_id,
        )
    except ServiceError as err:
        raise_http(err)


@router.put(
    "/ballots/proxy",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=CAST,
)
async def cast_proxy_ballot(
    session_id: uuid.UUID, body: BallotIn, account: CanProxy, db: AccountDb
) -> None:
    """Host votes on someone's behalf (stored with is_proxy and the host's account)."""
    try:
        await ballot_service.cast(
            db,
            account.household_id,
            session_id,
            body.person_id,
            _ranks(body),
            proxy_account_id=account.account_id,
        )
    except ServiceError as err:
        raise_http(err)


@router.get(
    "/ballots/mine",
    response_model=list[OwnBallotOut],
    responses={404: {"description": "No such night in this household"}},
)
async def my_ballots(
    session_id: uuid.UUID, device: CurrentDevice, db: DeviceDb
) -> list[OwnBallotOut]:
    """Ballots of the people actively bound to this phone, so it can show and edit them."""
    try:
        ballots = await ballot_service.own_ballots(
            db, device.household_id, device.device_id, session_id
        )
    except ServiceError as err:
        raise_http(err)
    return [
        OwnBallotOut(
            person_id=b.person_id, ranks=[RankOut(option_id=o, rank=r) for o, r in b.ranks]
        )
        for b in ballots
    ]


@router.get(
    "/voters",
    response_model=VotersOut,
    responses={404: {"description": "No such night in this household"}},
)
async def voters(session_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb) -> VotersOut:
    """Who has voted (avatar tiles light up on the TV). Never ranks or tallies."""
    try:
        voted = await ballot_service.voters(db, viewer.household_id, session_id)
    except ServiceError as err:
        raise_http(err)
    return VotersOut(
        voted=[
            VoterOut(person_id=v.person_id, avatar_emoji=v.avatar_emoji, color=v.color)
            for v in voted
        ]
    )
