"""The platform owner's API (ADR-0016): sign in, list and create households, enter one, switch
one off or on, rotate its join slug. `fnh_platform` cookie only; every mutation is
CSRF-protected and audited on the platform and, where a household is touched, in it."""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime
from typing import Annotated, NoReturn

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status

from app.api.v1.auth import BAD_LOGIN, login_account_budget, login_budget
from app.core.config import settings
from app.core.dependencies import (
    CsrfProtected,
    CurrentPlatform,
    PlatformContext,
    device_only,
    platform_claims,
    resolve_platform,
)
from app.core.rate_limit import retry_after, spend
from app.core.security import PlatformClaims, clear_platform_cookie, set_platform_cookie
from app.integrations.email import EmailSender, email_sender, send_safely
from app.schemas.platform import (
    PlatformDisableIn,
    PlatformHouseholdIn,
    PlatformHouseholdOut,
    PlatformLoginIn,
    PlatformMeOut,
)
from app.services import auth_service, platform_service
from app.services.errors import Conflict, Invalid, NotFound, ServiceError

router = APIRouter(prefix="/platform", tags=["platform"])

Sender = Annotated[EmailSender, Depends(email_sender)]


def _raise(err: ServiceError) -> NoReturn:
    if isinstance(err, NotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such household") from None
    if isinstance(err, Invalid):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, err.reason) from None
    if isinstance(err, Conflict):
        raise HTTPException(status.HTTP_409_CONFLICT, err.reason) from None
    raise err  # pragma: no cover


def _operator(platform: PlatformContext) -> platform_service.Operator:
    return platform_service.Operator(platform.account_id, platform.home_household_id)


def _household_out(h: platform_service.HouseholdSummary) -> PlatformHouseholdOut:
    return PlatformHouseholdOut(
        id=h.id,
        name=h.name,
        created_at=h.created_at,
        disabled_at=h.disabled_at,
        delete_after=h.delete_after,
        people=h.people,
        devices=h.devices,
        nights=h.nights,
        photos=h.photos,
        last_activity=h.last_activity,
    )


def _me(
    account_id: uuid.UUID,
    email: str,
    display_name: str,
    claims: PlatformClaims,
    entered_name: str | None,
) -> PlatformMeOut:
    return PlatformMeOut(
        account_id=account_id,
        email=email,
        display_name=display_name,
        entered_household_id=claims.entered_household_id,
        entered_household_name=entered_name,
        expires_at=datetime.fromtimestamp(
            claims.issued_at + settings.PLATFORM_SESSION_HOURS * 3600, UTC
        ),
    )


def _too_many(wait: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "Too many failed sign-ins. Try again later.",
        headers={"Retry-After": str(wait)},
    )


@router.post(
    "/login",
    response_model=PlatformMeOut,
    dependencies=[CsrfProtected],
    responses={
        401: {"description": "Wrong credentials, or not a platform operator (one answer)"},
        429: {"description": "Too many failed sign-ins"},
    },
)
async def login(body: PlatformLoginIn, request: Request, response: Response) -> PlatformMeOut:
    """A separate sign-in even with a family session (ADR-0016 §2). Shares the ADR-0014 login
    budgets, so the platform door is no softer than the family one."""
    if device_only(request):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_LOGIN)
    identity = auth_service.normalize_login(body.username_or_email)
    by_identifier = login_budget()
    wait = await retry_after(by_identifier, identity)
    if wait is not None:
        raise _too_many(wait)
    try:
        operator = await platform_service.sign_in(body.username_or_email, body.password)
    except auth_service.InvalidCredentials as err:
        await spend(by_identifier, identity)
        if err.account_id is not None:
            await spend(login_account_budget(), str(err.account_id))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_LOGIN) from None
    now = int(time.time())
    claims = PlatformClaims(operator.account_id, operator.home_household_id, None, now)
    set_platform_cookie(response, claims, now)
    email, display_name = await platform_service.profile(operator)
    return _me(operator.account_id, email, display_name, claims, None)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[CsrfProtected])
async def logout(request: Request, response: Response) -> None:
    platform = await resolve_platform(request)
    if platform is not None:
        if platform.entered_household_id is not None:
            await platform_service.exit_household(
                _operator(platform), platform.entered_household_id
            )
        await platform_service.signed_out(platform.account_id)
    clear_platform_cookie(response)


@router.get("/me", response_model=PlatformMeOut)
async def me(platform: CurrentPlatform) -> PlatformMeOut:
    entered = platform.entered_household_id
    name = await platform_service.household_name(entered, platform.account_id) if entered else None
    return _me(
        platform.account_id,
        platform.email,
        platform.display_name,
        platform_claims(platform, entered),
        name,
    )


@router.get("/households", response_model=list[PlatformHouseholdOut])
async def households(platform: CurrentPlatform) -> list[PlatformHouseholdOut]:
    return [_household_out(h) for h in await platform_service.list_households()]


@router.post(
    "/households",
    response_model=PlatformHouseholdOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={409: {"description": "The admin's email already has an account"}},
)
async def create_household(
    body: PlatformHouseholdIn,
    platform: CurrentPlatform,
    background: BackgroundTasks,
    sender: Sender,
) -> PlatformHouseholdOut:
    """A new household and its first admin's invite (ADR-0016 §7, ADR-0017 §1)."""
    try:
        created = await platform_service.create_household(
            _operator(platform),
            name=body.name,
            admin_email=body.admin_email,
            admin_name=body.admin_name,
        )
    except ServiceError as err:
        _raise(err)
    background.add_task(send_safely, sender, created.email)
    return _household_out(created.household)


@router.post(
    "/households/{household_id}/enter",
    response_model=PlatformMeOut,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No such household"}},
)
async def enter(
    household_id: uuid.UUID, platform: CurrentPlatform, response: Response
) -> PlatformMeOut:
    """Bind the platform session to this household (ADR-0016 §4). The family portal then acts
    as its admin, minus account management, nights and proxy votes, until exit. Entering
    another household replaces the binding; the session's clock never resets."""
    operator = _operator(platform)
    if platform.entered_household_id not in (None, household_id):
        await platform_service.exit_household(operator, platform.entered_household_id)
    try:
        name = await platform_service.enter(operator, household_id)
    except ServiceError as err:
        _raise(err)
    claims = platform_claims(platform, household_id)
    set_platform_cookie(response, claims, int(time.time()))
    return _me(platform.account_id, platform.email, platform.display_name, claims, name)


@router.post("/exit", response_model=PlatformMeOut, dependencies=[CsrfProtected])
async def exit_household(platform: CurrentPlatform, response: Response) -> PlatformMeOut:
    if platform.entered_household_id is not None:
        await platform_service.exit_household(_operator(platform), platform.entered_household_id)
    claims = platform_claims(platform, None)
    set_platform_cookie(response, claims, int(time.time()))
    return _me(platform.account_id, platform.email, platform.display_name, claims, None)


@router.post(
    "/households/{household_id}/disable",
    response_model=PlatformHouseholdOut,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No such household"}, 409: {"description": "Already off"}},
)
async def disable(
    household_id: uuid.UUID,
    body: PlatformDisableIn,
    platform: CurrentPlatform,
    background: BackgroundTasks,
    sender: Sender,
) -> PlatformHouseholdOut:
    """Sign-ins and joins refused, nothing deleted; the admins are emailed the reason."""
    try:
        household, emails = await platform_service.set_disabled(
            _operator(platform), household_id, disabled=True, reason=body.reason
        )
    except ServiceError as err:
        _raise(err)
    for message in emails:
        background.add_task(send_safely, sender, message)
    return _household_out(household)


@router.post(
    "/households/{household_id}/enable",
    response_model=PlatformHouseholdOut,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No such household"}, 409: {"description": "Already on"}},
)
async def enable(
    household_id: uuid.UUID, platform: CurrentPlatform, background: BackgroundTasks, sender: Sender
) -> PlatformHouseholdOut:
    try:
        household, emails = await platform_service.set_disabled(
            _operator(platform), household_id, disabled=False, reason=None
        )
    except ServiceError as err:
        _raise(err)
    for message in emails:
        background.add_task(send_safely, sender, message)
    return _household_out(household)


@router.post(
    "/households/{household_id}/rotate-slug",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses={404: {"description": "No such household"}},
)
async def rotate_slug(household_id: uuid.UUID, platform: CurrentPlatform) -> None:
    """On the family's request: their printed fridge QR stops working."""
    try:
        await platform_service.rotate_slug(_operator(platform), household_id)
    except ServiceError as err:
        _raise(err)
