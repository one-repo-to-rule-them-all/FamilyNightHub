"""Host/admin sign-in by magic link (ADR-0002)."""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status

from app.core.config import settings
from app.core.database import household_session
from app.core.dependencies import AccountDb, CsrfProtected, CurrentAccount
from app.core.rate_limit import Budget, retry_after, spend
from app.core.security import clear_account_cookie, set_account_cookie, sign_account_session
from app.integrations.email import EmailSender, email_sender, send_safely
from app.schemas.identity import AccountOut, MagicLinkIn, MagicLinkOut, VerifyIn
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])

SENT = "If that address belongs to a host or admin, a sign-in link is on its way."


def magic_link_budget() -> Budget:
    return Budget(
        "magic_link",
        settings.MAGIC_LINK_REQUEST_LIMIT,
        settings.MAGIC_LINK_REQUEST_WINDOW_SECONDS,
    )


@router.post(
    "/magic-link",
    response_model=MagicLinkOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[CsrfProtected],
    responses={429: {"description": "Too many requests for this address"}},
)
async def request_magic_link(
    body: MagicLinkIn,
    background: BackgroundTasks,
    sender: Annotated[EmailSender, Depends(email_sender)],
) -> MagicLinkOut:
    """Same answer, and the same work before answering, whether or not the account exists:
    the email goes out in a background task after the response."""
    identity = auth_service.normalize_email(body.email)
    budget = magic_link_budget()
    wait = await retry_after(budget, identity)
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many sign-in links requested. Try again later.",
            headers={"Retry-After": str(wait)},
        )
    await spend(budget, identity)
    message = await auth_service.request_magic_link(body.email)
    if message is not None:
        background.add_task(send_safely, sender, message)
    return MagicLinkOut(detail=SENT)


@router.post(
    "/verify",
    response_model=AccountOut,
    dependencies=[CsrfProtected],
    responses={400: {"description": "Link invalid, expired or already used"}},
)
async def verify(body: VerifyIn, response: Response) -> AccountOut:
    try:
        signed_in = await auth_service.verify_magic_link(body.token)
    except auth_service.InvalidLink:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This sign-in link is invalid or has expired."
        ) from None
    set_account_cookie(
        response,
        sign_account_session(signed_in.account_id, signed_in.household_id, int(time.time())),
    )
    async with household_session(signed_in.household_id) as db:
        summary = await auth_service.account_summary(db, signed_in.account_id)
    return _account_out(summary)


@router.get("/me", response_model=AccountOut)
async def me(account: CurrentAccount, db: AccountDb) -> AccountOut:
    return _account_out(await auth_service.account_summary(db, account.account_id))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[CsrfProtected])
async def logout(response: Response) -> None:
    clear_account_cookie(response)


def _account_out(summary: auth_service.AccountSummary) -> AccountOut:
    return AccountOut(
        id=summary.id,
        email=summary.email,
        display_name=summary.display_name,
        role=summary.role,  # validated by AccountOut; DB check constraint is admin/host
        household_name=summary.household_name,
    )
