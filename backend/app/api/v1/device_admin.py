"""Host-authorized device actions (ADR-0002): enroll without the code, pair the TV, review
claims on people bound to another phone."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    require_permission,
    resolve_device_token,
)
from app.core.security import DEVICE_COOKIE, clear_account_cookie, set_device_cookie
from app.schemas.identity import ClaimOut, EnrollIn, EnrollOut
from app.services import device_admin_service
from app.services.errors import NotFound

router = APIRouter(prefix="/devices", tags=["devices"])

CanEnroll = Annotated[AccountContext, Depends(require_permission("devices:enroll"))]
CanApprove = Annotated[AccountContext, Depends(require_permission("devices:approve"))]


@router.post("/enroll", response_model=EnrollOut, dependencies=[CsrfProtected])
async def enroll(
    body: EnrollIn, request: Request, response: Response, account: CanEnroll, db: AccountDb
) -> EnrollOut:
    """Let this browser in on the signed-in host's authority. With `as_tv`, the device is
    marked as the TV and the host session is cleared from this browser, so a TV left in the
    living room never holds host rights. With `keep_session` as well (the host's own laptop
    driving the TV from a second window), the session stays: the two cookies have different
    names and the TV screens send the device-only header, so neither clobbers the other."""
    existing_id: uuid.UUID | None = None
    token = request.cookies.get(DEVICE_COOKIE)
    if token:
        resolved = await resolve_device_token(token)
        if resolved is not None and resolved[1] == account.household_id:
            existing_id = resolved[0]
    result = await device_admin_service.enroll(
        db,
        account.household_id,
        account.account_id,
        existing_device_id=existing_id,
        label=body.device_label,
        as_tv=body.as_tv,
    )
    if result.new_token is not None:
        set_device_cookie(response, result.new_token)
    if body.as_tv and not body.keep_session:
        clear_account_cookie(response)
    return EnrollOut(device_id=result.device_id, is_tv=result.is_tv)


@router.get("/claims", response_model=list[ClaimOut])
async def list_claims(account: CanApprove, db: AccountDb) -> list[ClaimOut]:
    return [
        ClaimOut(
            device_id=c.device_id,
            device_label=c.device_label,
            person_id=c.person_id,
            person_name=c.person_name,
            avatar_emoji=c.avatar_emoji,
            requested_at=c.requested_at,
        )
        for c in await device_admin_service.pending_claims(db)
    ]


@router.post(
    "/{device_id}/people/{person_id}/approve",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No pending claim"}},
)
async def approve_claim(
    device_id: uuid.UUID, person_id: uuid.UUID, account: CanApprove, db: AccountDb
) -> None:
    try:
        await device_admin_service.approve_claim(
            db, account.household_id, account.account_id, device_id, person_id
        )
    except NotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No pending claim") from None


@router.post(
    "/{device_id}/people/{person_id}/reject",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No pending claim"}},
)
async def reject_claim(
    device_id: uuid.UUID, person_id: uuid.UUID, account: CanApprove, db: AccountDb
) -> None:
    try:
        await device_admin_service.reject_claim(
            db, account.household_id, account.account_id, device_id, person_id
        )
    except NotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No pending claim") from None
