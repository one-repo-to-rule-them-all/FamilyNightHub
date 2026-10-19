"""Hosts and admins in the owner portal (issue #71, `admin:accounts`): invite by email,
list, change role, remove access."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.core.config import settings
from app.core.dependencies import AccountContext, AccountDb, CsrfProtected, require_permission
from app.core.rate_limit import Budget, retry_after, spend
from app.integrations.email import EmailSender, email_sender, send_safely
from app.schemas.admin import AccountInviteIn, AccountRoleIn, AdminAccountOut
from app.services import accounts_admin_service as svc
from app.services.errors import Conflict, NotFound, ServiceError

router = APIRouter(prefix="/accounts", tags=["admin"])

CanManageAccounts = Annotated[AccountContext, Depends(require_permission("admin:accounts"))]
Sender = Annotated[EmailSender, Depends(email_sender)]

NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"description": "No such live account here"}}
LAST_ADMIN: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    409: {"description": "Would leave the household without an admin"},
}
THROTTLED: dict[int | str, dict[str, Any]] = {
    429: {"description": "Too many invites from this admin or to this address"}
}


def invite_by_account() -> Budget:
    return Budget("invite_account", settings.INVITE_ACCOUNT_LIMIT, settings.INVITE_WINDOW_SECONDS)


def invite_by_email() -> Budget:
    return Budget("invite_email", settings.INVITE_EMAIL_LIMIT, settings.INVITE_WINDOW_SECONDS)


async def _spend_invite(account: AccountContext, email: str) -> None:
    """Every invite or resend counts, per inviting account and per invited address (never
    the client IP). A spent budget answers 429 before anything is written or sent."""
    checks = ((invite_by_account(), str(account.account_id)), (invite_by_email(), email))
    for budget, identity in checks:
        wait = await retry_after(budget, identity)
        if wait is not None:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many invites. Try again later.",
                headers={"Retry-After": str(wait)},
            )
    for budget, identity in checks:
        await spend(budget, identity)


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found") from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    raise err  # pragma: no cover


def _out(a: svc.AdminAccount, me: AccountContext) -> AdminAccountOut:
    return AdminAccountOut(
        id=a.id,
        email=a.email,
        username=a.username,
        display_name=a.display_name,
        role=a.role,  # validated by AdminAccountOut; DB check is admin/host
        status="active" if a.has_password else "invited",
        is_you=a.id == me.account_id,
        invite_expires_at=a.invite_expires_at,
        created_at=a.created_at,
    )


@router.get("", response_model=list[AdminAccountOut])
async def list_accounts(account: CanManageAccounts, db: AccountDb) -> list[AdminAccountOut]:
    """Live hosts and admins, admins first. Removed accounts are in the audit log only."""
    return [_out(a, account) for a in await svc.list_accounts(db)]


@router.post(
    "",
    response_model=AdminAccountOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={
        409: {"description": "Already has access here, or the email/username is taken"},
        **THROTTLED,
    },
)
async def invite_account(
    body: AccountInviteIn,
    account: CanManageAccounts,
    db: AccountDb,
    background: BackgroundTasks,
    sender: Sender,
) -> AdminAccountOut:
    """Invite an adult as host or admin. They get an emailed single-use link and choose
    their own password; the link is never returned here."""
    await _spend_invite(account, body.email)
    try:
        invited = await svc.invite(
            db,
            account.household_id,
            account.account_id,
            email=body.email,
            display_name=body.display_name,
            role=body.role,
            username=body.username,
        )
    except ServiceError as err:
        _raise(err)
    background.add_task(send_safely, sender, invited.email)
    return _out(invited.account, account)


@router.post(
    "/{account_id}/resend",
    response_model=AdminAccountOut,
    dependencies=[CsrfProtected],
    responses={**NOT_FOUND, 409: {"description": "Already set a password"}, **THROTTLED},
)
async def resend_invite(
    account_id: uuid.UUID,
    account: CanManageAccounts,
    db: AccountDb,
    background: BackgroundTasks,
    sender: Sender,
) -> AdminAccountOut:
    """A fresh link for someone who hasn't set a password yet; the previous one dies."""
    try:
        target = await svc.get_account(db, account_id)
        await _spend_invite(account, target.email.lower())
        invited = await svc.resend_invite(db, account.household_id, account.account_id, account_id)
    except ServiceError as err:
        _raise(err)
    background.add_task(send_safely, sender, invited.email)
    return _out(invited.account, account)


@router.patch(
    "/{account_id}",
    response_model=AdminAccountOut,
    dependencies=[CsrfProtected],
    responses=LAST_ADMIN,
)
async def change_role(
    account_id: uuid.UUID, body: AccountRoleIn, account: CanManageAccounts, db: AccountDb
) -> AdminAccountOut:
    """Takes effect on the account's next request (the role is re-read every time)."""
    try:
        changed = await svc.change_role(
            db, account.household_id, account.account_id, account_id, body.role
        )
    except ServiceError as err:
        _raise(err)
    return _out(changed, account)


@router.delete(
    "/{account_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=LAST_ADMIN,
)
async def remove_account(account_id: uuid.UUID, account: CanManageAccounts, db: AccountDb) -> None:
    """Remove access: the account can't sign in and its signed-in browsers stop working on
    their next request. Its past nights and audit rows stay."""
    try:
        await svc.remove(db, account.household_id, account.account_id, account_id)
    except ServiceError as err:
        _raise(err)
