"""Test helpers: a "phone" is an HTTP client with its own cookie jar, like a real device.

The base URL is https because the device and CSRF cookies are `Secure`; an http client
would silently drop them and every test would see a logged-out phone.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import text

from app.core.database import household_session
from app.core.security import CSRF_HEADER, hash_night_code
from app.main import app


class Phone:
    def __init__(self, client: AsyncClient) -> None:
        self.client = client
        self._csrf: str | None = None

    async def csrf(self) -> str:
        if self._csrf is None:
            resp = await self.client.get("/api/v1/csrf")
            resp.raise_for_status()
            self._csrf = resp.json()["csrf_token"]
        return self._csrf

    async def join(self, slug: str, code: str, **extra: Any) -> Response:
        return await self.client.post(
            "/api/v1/join",
            json={"slug": slug, "night_code": code, **extra},
            headers={CSRF_HEADER: await self.csrf()},
        )

    async def bind(self, person_id: uuid.UUID) -> Response:
        return await self.client.put(
            f"/api/v1/devices/me/people/{person_id}", headers={CSRF_HEADER: await self.csrf()}
        )

    async def unbind(self, person_id: uuid.UUID) -> Response:
        return await self.client.delete(
            f"/api/v1/devices/me/people/{person_id}", headers={CSRF_HEADER: await self.csrf()}
        )


@asynccontextmanager
async def phone() -> AsyncIterator[Phone]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="https://fnh.test") as client:
        yield Phone(client)


async def open_night(
    household_id: uuid.UUID, session_id: uuid.UUID, code: str, status: str = "voting"
) -> None:
    """Give a seeded session a real night-code hash and status."""
    async with household_session(household_id) as db:
        await db.execute(
            text("UPDATE sessions SET night_code_hash = :c, status = :s WHERE id = :id"),
            {"c": hash_night_code(code, household_id), "s": status, "id": session_id},
        )
