"""Scheduling and cancelling the household's deletion (ADR-0017 §4), `admin:settings`."""

from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.api.v1.auth import login_account_budget
from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.core.rate_limit import retry_after, spend
from app.integrations.email import EmailSender, email_sender, send_safely
from app.schemas.admin import HouseholdDeletionIn, HouseholdDeletionOut
from app.services import household_deletion_service as deletion
from app.services.errors import Conflict, Invalid, ServiceError

router = APIRouter(prefix="/household/deletion", tags=["admin"])

CanManage = Annotated[AccountContext, Depends(require_permission("admin:settings"))]
Sender = Annotated[EmailSender, Depends(email_sender)]


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, deletion.WrongPassword):
        raise HTTPException(status.HTTP_403_FORBIDDEN, err.reason) from None
    if isinstance(err, Invalid):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    raise err  # pragma: no cover


def _out(s: deletion.DeletionStatus) -> HouseholdDeletionOut:
    return HouseholdDeletionOut(
        household_name=s.household_name,
        requested_at=s.requested_at,
        requested_by=s.requested_by,
        delete_after=s.delete_after,
    )


@router.get("", response_model=HouseholdDeletionOut)
async def deletion_status(account: CanManage, db: AccountDb) -> HouseholdDeletionOut:
    return _out(await deletion.status(db))


@router.post(
    "",
    response_model=HouseholdDeletionOut,
    dependencies=[CsrfProtected],
    responses={
        403: {"description": "Wrong password"},
        409: {"description": "Already scheduled"},
        422: {"description": "The typed name doesn't match"},
        429: {"description": "Too many wrong passwords for this account"},
    },
)
async def request_deletion(
    body: HouseholdDeletionIn,
    account: CanManage,
    db: AccountDb,
    background: BackgroundTasks,
    sender: Sender,
) -> HouseholdDeletionOut:
    """Schedule the delete HOUSEHOLD_DELETE_GRACE_DAYS ahead and email every admin. A wrong
    password spends the account's sign-in budget, like changing a password does."""
    budget = login_account_budget()
    wait = await retry_after(budget, str(account.account_id))
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many wrong passwords. Try again later.",
            headers={"Retry-After": str(wait)},
        )
    try:
        scheduled = await deletion.request(
            db,
            account.household_id,
            account.account_id,
            password=body.password,
            household_name=body.household_name,
        )
    except deletion.WrongPassword as err:
        await spend(budget, str(account.account_id))
        _raise(err)
    except ServiceError as err:
        _raise(err)
    for message in scheduled.emails:
        background.add_task(send_safely, sender, message)
    return _out(scheduled.status)


@router.delete(
    "",
    response_model=HouseholdDeletionOut,
    dependencies=[CsrfProtected],
    responses={409: {"description": "Nothing is scheduled"}},
)
async def cancel_deletion(
    account: CanManage, db: AccountDb, background: BackgroundTasks, sender: Sender
) -> HouseholdDeletionOut:
    try:
        scheduled = await deletion.cancel(db, account.household_id, account.account_id)
    except ServiceError as err:
        _raise(err)
    for message in scheduled.emails:
        background.add_task(send_safely, sender, message)
    return _out(scheduled.status)
