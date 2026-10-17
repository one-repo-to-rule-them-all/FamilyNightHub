"""Host/admin sign-in (ADR-0014): username or email + password; the magic link resets it."""

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
from app.schemas.identity import (
    AccountOut,
    LoginIn,
    MagicLinkIn,
    MagicLinkOut,
    PasswordIn,
    VerifyIn,
)
from app.services import auth_service
from app.services.errors import Invalid

router = APIRouter(prefix="/auth", tags=["auth"])

SENT = "If that address belongs to a host or admin, a password-reset link is on its way."
BAD_LOGIN = "Wrong username, email or password."


def magic_link_budget() -> Budget:
    return Budget(
        "magic_link",
        settings.MAGIC_LINK_REQUEST_LIMIT,
        settings.MAGIC_LINK_REQUEST_WINDOW_SECONDS,
    )


def login_budget() -> Budget:
    """Failures per normalized identifier, whether or not it names an account."""
    return Budget("login", settings.LOGIN_FAILURE_LIMIT, settings.LOGIN_FAILURE_WINDOW_SECONDS)


def login_account_budget() -> Budget:
    """Failures per account, across its email and username."""
    return Budget(
        "login_account",
        settings.LOGIN_ACCOUNT_FAILURE_LIMIT,
        settings.LOGIN_FAILURE_WINDOW_SECONDS,
    )


def _too_many(wait: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "Too many failed sign-ins. Try again later.",
        headers={"Retry-After": str(wait)},
    )


def _sign_in(response: Response, signed_in: auth_service.SignedIn) -> None:
    set_account_cookie(
        response,
        sign_account_session(signed_in.account_id, signed_in.household_id, int(time.time())),
    )


@router.post(
    "/login",
    response_model=AccountOut,
    dependencies=[CsrfProtected],
    responses={
        401: {"description": "Wrong username, email or password (one answer for all)"},
        429: {"description": "Too many failed sign-ins for this identifier or account"},
    },
)
async def login(body: LoginIn, response: Response) -> AccountOut:
    """Sets the `fnh_session` cookie. Every failure looks the same: no user enumeration.
    A spent budget is refused before the password is checked."""
    identity = auth_service.normalize_login(body.username_or_email)
    by_identifier = login_budget()
    wait = await retry_after(by_identifier, identity)
    if wait is not None:
        raise _too_many(wait)
    found = await auth_service.resolve_login(body.username_or_email)
    by_account = login_account_budget()
    if found is not None:
        wait = await retry_after(by_account, str(found.account_id))
        if wait is not None:
            raise _too_many(wait)
    try:
        signed_in = await auth_service.login(found, body.password)
    except auth_service.InvalidCredentials as err:
        await spend(by_identifier, identity)
        if err.account_id is not None:
            await spend(by_account, str(err.account_id))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_LOGIN) from None
    _sign_in(response, signed_in)
    async with household_session(signed_in.household_id) as db:
        summary = await auth_service.account_summary(db, signed_in.account_id)
    return _account_out(summary)


@router.post(
    "/password",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses={
        403: {"description": "Current password missing or wrong"},
        422: {"description": "New password breaks the rules"},
        429: {"description": "Too many failed password checks for this account"},
    },
)
async def set_password(body: PasswordIn, account: CurrentAccount, db: AccountDb) -> None:
    """Set a first password, or change it (the current one is required then). Other signed-in
    browsers stay signed in (stateless sessions, 03-backend.md)."""
    by_account = login_account_budget()
    wait = await retry_after(by_account, str(account.account_id))
    if wait is not None:
        raise _too_many(wait)
    try:
        await auth_service.set_password(
            db,
            account.household_id,
            account.account_id,
            new_password=body.new_password,
            current_password=body.current_password,
        )
    except auth_service.WrongPassword:
        await spend(by_account, str(account.account_id))
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Current password is wrong") from None
    except Invalid as err:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None


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
    """Forgot password. Same answer, and the same work before answering, whether or not the
    account exists: the email goes out in a background task after the response."""
    identity = auth_service.normalize_email(body.email)
    budget = magic_link_budget()
    wait = await retry_after(budget, identity)
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many reset links requested. Try again later.",
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
    responses={
        400: {"description": "Link invalid, expired or already used"},
        422: {"description": "New password breaks the rules (the link is not used up)"},
    },
)
async def verify(body: VerifyIn, response: Response) -> AccountOut:
    """Consume a reset link: sets `new_password` and signs in."""
    try:
        signed_in = await auth_service.verify_magic_link(body.token, body.new_password)
    except auth_service.InvalidLink:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This sign-in link is invalid or has expired."
        ) from None
    except Invalid as err:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    _sign_in(response, signed_in)
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
        username=summary.username,
        has_password=summary.has_password,
        display_name=summary.display_name,
        role=summary.role,  # validated by AccountOut; DB check constraint is admin/host
        household_name=summary.household_name,
    )
