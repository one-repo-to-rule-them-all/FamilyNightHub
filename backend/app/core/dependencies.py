"""Request dependencies: who is calling, and a household-scoped transaction (ADR-0002/3).

The household always comes from the credential. `current_device` resolves the cookie via
the ADR-0009 resolver (no GUC needed), then `device_db` opens the one transaction the
request runs in, with `app.household_id` set. Commit happens when the dependency exits,
before the response is sent.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, household_session
from app.core.security import (
    CSRF_COOKIE,
    CSRF_HEADER,
    DEVICE_COOKIE,
    csrf_matches,
    hash_device_token,
    set_device_cookie,
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
        yield session


DeviceDb = Annotated[AsyncSession, Depends(device_db)]


async def require_csrf(request: Request) -> None:
    """Double-submit check for every cookie-authenticated mutation (03-backend.md)."""
    if not csrf_matches(request.cookies.get(CSRF_COOKIE), request.headers.get(CSRF_HEADER)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")


CsrfProtected = Depends(require_csrf)
