"""Credential primitives: device tokens, night-code hashes, cookies, CSRF (ADR-0002).

Only peppered HMAC-SHA256 digests are stored. Each purpose gets its own message prefix
(domain separation), so a device-token hash can never collide with a night-code hash.
The pepper lives only in fly secrets, so a database dump alone cannot verify a guess.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid

from fastapi import Response

from app.core.config import settings

DEVICE_COOKIE = "fnh_device"
CSRF_COOKIE = "fnh_csrf"
CSRF_HEADER = "X-FNH-CSRF"


def new_token() -> str:
    """256 bits of randomness, URL-safe (43 chars)."""
    return secrets.token_urlsafe(32)


def _digest(message: str) -> str:
    return hmac.new(
        settings.DEVICE_TOKEN_PEPPER.encode(), message.encode(), hashlib.sha256
    ).hexdigest()


def hash_device_token(token: str) -> str:
    return _digest(f"device:{token}")


def hash_night_code(code: str, household_id: uuid.UUID) -> str:
    """`code` must already be normalized (app.domain.night_code.normalize).

    Bound to the household so equal codes in two households hash differently.
    """
    return _digest(f"night:{household_id}:{code}")


def set_device_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        DEVICE_COOKIE,
        token,
        max_age=settings.DEVICE_COOKIE_MAX_AGE_DAYS * 86400,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def set_csrf_cookie(response: Response, token: str) -> None:
    """Double-submit token: readable by the page so it can echo it in CSRF_HEADER."""
    response.set_cookie(
        CSRF_COOKIE,
        token,
        max_age=settings.DEVICE_COOKIE_MAX_AGE_DAYS * 86400,
        path="/",
        secure=True,
        httponly=False,
        samesite="lax",
    )


def csrf_matches(cookie_value: str | None, header_value: str | None) -> bool:
    if not cookie_value or not header_value:
        return False
    return hmac.compare_digest(cookie_value.encode(), header_value.encode())
