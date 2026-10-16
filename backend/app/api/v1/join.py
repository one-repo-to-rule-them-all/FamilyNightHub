"""CSRF bootstrap and the night-code join (ADR-0002)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.core.config import settings
from app.core.dependencies import CsrfProtected
from app.core.rate_limit import Budget, record_failure, retry_after
from app.core.security import (
    CSRF_COOKIE,
    DEVICE_COOKIE,
    new_token,
    set_csrf_cookie,
    set_device_cookie,
)
from app.schemas.identity import CsrfOut, JoinIn, JoinOut
from app.services import join_service
from app.services.errors import InvalidJoin

router = APIRouter(tags=["join"])


def join_budget() -> Budget:
    return Budget("join", settings.JOIN_FAILURE_LIMIT, settings.JOIN_FAILURE_WINDOW_SECONDS)


@router.get("/csrf", response_model=CsrfOut)
async def issue_csrf(request: Request, response: Response) -> CsrfOut:
    """Returns the double-submit token, minting the cookie if the browser has none."""
    token = request.cookies.get(CSRF_COOKIE) or new_token()
    set_csrf_cookie(response, token)
    return CsrfOut(csrf_token=token)


@router.post(
    "/join",
    response_model=JoinOut,
    dependencies=[CsrfProtected],
    responses={400: {"description": "Invalid join"}, 429: {"description": "Too many failures"}},
)
async def join(body: JoinIn, request: Request, response: Response) -> JoinOut:
    budget = join_budget()
    wait = await retry_after(budget, body.slug)
    if wait is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many attempts. Ask the host to let this phone in, or try again later.",
            headers={"Retry-After": str(wait)},
        )
    try:
        result = await join_service.join(
            body.slug,
            body.night_code,
            existing_token=request.cookies.get(DEVICE_COOKIE),
            label=body.device_label,
        )
    except InvalidJoin:
        await record_failure(budget, body.slug)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "That code doesn't match tonight's night."
        ) from None
    if result.new_token is not None:
        set_device_cookie(response, result.new_token)
    return JoinOut(
        household_name=result.household_name,
        session_id=result.session_id,
        device_id=result.device_id,
    )
