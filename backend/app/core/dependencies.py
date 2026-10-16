"""Request dependencies: who is calling, and a household-scoped transaction (ADR-0002/3).

The household always comes from the credential. `current_device` resolves the cookie via
the ADR-0009 resolver (no GUC needed), then `device_db` opens the one transaction the
request runs in, with `app.household_id` set.

The three transaction dependencies are declared with `scope="function"`: they exit, and so
COMMIT, when the path operation returns and BEFORE the response is sent. FastAPI's default
("request") would commit after the client already has its 200, so a phone refetching right
after a write could read the pre-write state, and a failed commit would surface after
success was reported. tests/integration/test_commit_before_response.py pins this.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.core.permissions import Permission, has_permission
from app.core.security import (
    ACCOUNT_COOKIE,
    CSRF_COOKIE,
    CSRF_HEADER,
    DEVICE_COOKIE,
    csrf_matches,
    hash_device_token,
    set_device_cookie,
    verify_account_session,
)


@dataclass(frozen=True)
class DeviceContext:
    device_id: uuid.UUID
    household_id: uuid.UUID
    token: str


async def resolve_device_token(token: str) -> tuple[uuid.UUID, uuid.UUID] | None:
    """(device_id, household_id) for a live token, else None. Runs before any GUC."""
    async with AsyncSessionLocal() as session, session.begin():
        row = (
            await session.execute(
                text("SELECT device_id, household_id FROM auth_resolve_device(:h)"),
                {"h": hash_device_token(token)},
            )
        ).first()
    return (row.device_id, row.household_id) if row else None


async def current_device(request: Request) -> DeviceContext:
    token = request.cookies.get(DEVICE_COOKIE)
    resolved = await resolve_device_token(token) if token else None
    if resolved is None:
        # Unknown, revoked and missing all look the same to the caller.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Device not recognised")
    device_id, household_id = resolved
    return DeviceContext(device_id=device_id, household_id=household_id, token=token or "")


CurrentDevice = Annotated[DeviceContext, Depends(current_device)]


async def device_db(device: CurrentDevice, response: Response) -> AsyncIterator[AsyncSession]:
    """The request's household transaction. Also keeps the cookie sliding: at most once per
    DEVICE_TOUCH_INTERVAL_SECONDS it stamps last_seen_at and re-issues the cookie."""
    async with household_session(device.household_id) as session:
        await _touch_device(session, device, response)
        yield session


async def _touch_device(session: AsyncSession, device: DeviceContext, response: Response) -> None:
    stale_before = datetime.now(UTC) - timedelta(seconds=settings.DEVICE_TOUCH_INTERVAL_SECONDS)
    touched = await session.execute(
        text(
            "UPDATE devices SET last_seen_at = now() WHERE id = :d "
            "AND (last_seen_at IS NULL OR last_seen_at < :stale)"
        ),
        {"d": device.device_id, "stale": stale_before},
    )
    if touched.rowcount:  # type: ignore[attr-defined]
        set_device_cookie(response, device.token)


DeviceDb = Annotated[AsyncSession, Depends(device_db, scope="function")]


@dataclass(frozen=True)
class AccountContext:
    account_id: uuid.UUID
    household_id: uuid.UUID
    role: str


async def current_account(request: Request) -> AccountContext:
    """Signed `fnh_session` cookie, then a fresh read of the account row (role, disabled),
    so a disabled account or changed role takes effect on the next request."""
    raw = request.cookies.get(ACCOUNT_COOKIE)
    claims = verify_account_session(raw, int(time.time())) if raw else None
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in required")
    async with household_session(claims.household_id) as session:
        row = (
            await session.execute(
                text(
                    "SELECT role FROM accounts WHERE id = :a AND household_id = :h "
                    "AND disabled_at IS NULL"
                ),
                {"a": claims.account_id, "h": claims.household_id},
            )
        ).first()
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in required")
    return AccountContext(claims.account_id, claims.household_id, row.role)


CurrentAccount = Annotated[AccountContext, Depends(current_account)]


async def account_db(account: CurrentAccount) -> AsyncIterator[AsyncSession]:
    async with household_session(account.household_id) as session:
        yield session


AccountDb = Annotated[AsyncSession, Depends(account_db, scope="function")]


def require_permission(permission: Permission) -> Callable[..., Awaitable[AccountContext]]:
    """Dependency factory: 403 unless the signed-in account's role grants `permission`."""

    async def check(account: CurrentAccount) -> AccountContext:
        if not has_permission(account.role, permission):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed for your role")
        return account

    return check


@dataclass(frozen=True)
class ViewerContext:
    """Anyone in the household who may *read* a night: a device or a signed-in account."""

    household_id: uuid.UUID
    device: DeviceContext | None
    account_id: uuid.UUID | None
    # The account's role when the viewer is an account (e.g. moderators see hidden photos).
    role: str | None = None


async def current_viewer(request: Request) -> ViewerContext:
    """A signed-in account if the session cookie is valid, else a live device; else 401.
    Read-only routes (the night snapshot) use this so the TV, phones and hosts share them."""
    if request.cookies.get(ACCOUNT_COOKIE):
        try:
            account = await current_account(request)
        except HTTPException:
            pass
        else:
            return ViewerContext(account.household_id, None, account.account_id, account.role)
    device = await current_device(request)
    return ViewerContext(device.household_id, device, None)


CurrentViewer = Annotated[ViewerContext, Depends(current_viewer)]


async def viewer_db(viewer: CurrentViewer, response: Response) -> AsyncIterator[AsyncSession]:
    """Same transaction as DeviceDb/AccountDb; a device viewer's cookie slides as usual."""
    async with household_session(viewer.household_id) as session:
        if viewer.device is not None:
            await _touch_device(session, viewer.device, response)
        yield session


ViewerDb = Annotated[AsyncSession, Depends(viewer_db, scope="function")]


async def require_csrf(request: Request) -> None:
    """Double-submit check for every cookie-authenticated mutation (03-backend.md)."""
    if not csrf_matches(request.cookies.get(CSRF_COOKIE), request.headers.get(CSRF_HEADER)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")


CsrfProtected = Depends(require_csrf)
