"""Forgot-PIN requests in the admin portal (ADR-0014, `admin:people`)."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    require_household_account,
    require_permission,
)
from app.schemas.admin import PinResetCountOut, PinResetOut
from app.services import people_admin_service
from app.services.errors import Conflict, NotFound, ServiceError

router = APIRouter(prefix="/people/pin-resets", tags=["admin"])

CanManagePeople = Annotated[AccountContext, Depends(require_permission("admin:people"))]
# Resolving names the admin in a household-scoped FK: the household's own admins only.
CanResolve = Annotated[AccountContext, Depends(require_household_account)]

RESOLVE: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such request in this household"},
    409: {"description": "Already approved or dismissed"},
}


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PIN reset request not found") from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    raise err  # pragma: no cover


def _out(r: people_admin_service.PinReset) -> PinResetOut:
    return PinResetOut(
        id=r.id,
        person_id=r.person_id,
        person_name=r.person_name,
        avatar_emoji=r.avatar_emoji,
        person_locked=r.person_locked,
        requested_by_device_id=r.requested_by_device_id,
        device_label=r.device_label,
        status=r.status,  # validated by PinResetOut; DB check is open/approved/dismissed
        requested_at=r.requested_at,
        resolved_at=r.resolved_at,
    )


@router.get("", response_model=list[PinResetOut])
async def list_pin_resets(account: CanManagePeople, db: AccountDb) -> list[PinResetOut]:
    """Open requests, oldest first."""
    return [_out(r) for r in await people_admin_service.list_pin_resets(db)]


@router.get("/count", response_model=PinResetCountOut)
async def count_pin_resets(account: CanManagePeople, db: AccountDb) -> PinResetCountOut:
    """Open requests, for the admin nav badge."""
    return PinResetCountOut(open_count=await people_admin_service.open_pin_reset_count(db))


@router.post(
    "/{request_id}/approve",
    response_model=PinResetOut,
    dependencies=[CsrfProtected],
    responses=RESOLVE,
)
async def approve_pin_reset(
    request_id: uuid.UUID, account: CanManagePeople, _own: CanResolve, db: AccountDb
) -> PinResetOut:
    """Clear the person's PIN, failure count and lock. No PIN is set or revealed: the person
    chooses a new one on their next claim."""
    try:
        reset = await people_admin_service.approve_pin_reset(
            db, account.household_id, account.account_id, request_id
        )
    except ServiceError as err:
        _raise(err)
    return _out(reset)


@router.post(
    "/{request_id}/dismiss",
    response_model=PinResetOut,
    dependencies=[CsrfProtected],
    responses=RESOLVE,
)
async def dismiss_pin_reset(
    request_id: uuid.UUID, account: CanManagePeople, _own: CanResolve, db: AccountDb
) -> PinResetOut:
    try:
        reset = await people_admin_service.dismiss_pin_reset(
            db, account.household_id, account.account_id, request_id
        )
    except ServiceError as err:
        _raise(err)
    return _out(reset)
