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
from dataclasses import dataclass

from fastapi import Response

from app.core.config import settings

DEVICE_COOKIE = "fnh_device"
ACCOUNT_COOKIE = "fnh_session"
PLATFORM_COOKIE = "fnh_platform"
CSRF_COOKIE = "fnh_csrf"
CSRF_HEADER = "X-FNH-CSRF"
# Sent by the TV screens (ADR-0002 amendment 2026-10-18): this request runs on the device
# cookie only, even when the browser also holds the host's `fnh_session`. It can only take
# authority away, so it needs no protection of its own.
DEVICE_ONLY_HEADER = "X-FNH-Device-Only"


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


def hash_magic_link_token(token: str) -> str:
    return _digest(f"magic:{token}")


# --- Account sessions: signed, stateless cookie ------------------------------------
#
# Payload is `{account_id}.{household_id}.{issued_at}` signed with HMAC-SHA256 under
# SESSION_SECRET. Role and disabled state are NOT in the cookie: CurrentAccount re-reads
# the account row on every request, so disabling an account cuts its sessions at once.
# Trade-off: a single stolen session cannot be revoked on its own (disable the account or
# rotate SESSION_SECRET). See 03-backend.md "Account sessions".


@dataclass(frozen=True)
class AccountClaims:
    account_id: uuid.UUID
    household_id: uuid.UUID
    issued_at: int


def _session_mac(payload: str) -> str:
    return hmac.new(
        settings.SESSION_SECRET.encode(), f"session:{payload}".encode(), hashlib.sha256
    ).hexdigest()


def sign_account_session(account_id: uuid.UUID, household_id: uuid.UUID, now: int) -> str:
    payload = f"{account_id}.{household_id}.{now}"
    return f"{payload}.{_session_mac(payload)}"


def verify_account_session(value: str, now: int) -> AccountClaims | None:
    """Claims for a well-signed, unexpired cookie; None for anything else."""
    parts = value.split(".")
    if len(parts) != 4:
        return None
    payload, mac = ".".join(parts[:3]), parts[3]
    if not hmac.compare_digest(mac.encode(), _session_mac(payload).encode()):
        return None
    try:
        claims = AccountClaims(uuid.UUID(parts[0]), uuid.UUID(parts[1]), int(parts[2]))
    except ValueError:
        return None
    max_age = settings.ACCOUNT_SESSION_MAX_AGE_DAYS * 86400
    if not (claims.issued_at <= now < claims.issued_at + max_age):
        return None
    return claims


def set_account_cookie(response: Response, value: str) -> None:
    response.set_cookie(
        ACCOUNT_COOKIE,
        value,
        max_age=settings.ACCOUNT_SESSION_MAX_AGE_DAYS * 86400,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def clear_account_cookie(response: Response) -> None:
    response.delete_cookie(ACCOUNT_COOKIE, path="/", secure=True, httponly=True, samesite="lax")


# --- Platform sessions (ADR-0016) ---------------------------------------------------
#
# `{account_id}.{home_household_id}.{entered_household_id or "-"}.{issued_at}`, HMAC-SHA256
# under PLATFORM_SESSION_SECRET with its own prefix, so an account cookie can never pass as
# one. `home` is the operator's own household, needed to re-read their account under RLS.
# Entering a household re-signs with the same `issued_at`: the session never outlives
# PLATFORM_SESSION_HOURS from sign-in.


@dataclass(frozen=True)
class PlatformClaims:
    account_id: uuid.UUID
    home_household_id: uuid.UUID
    entered_household_id: uuid.UUID | None
    issued_at: int


def _platform_mac(payload: str) -> str:
    return hmac.new(
        settings.PLATFORM_SESSION_SECRET.encode(), f"platform:{payload}".encode(), hashlib.sha256
    ).hexdigest()


def sign_platform_session(claims: PlatformClaims) -> str:
    entered = str(claims.entered_household_id) if claims.entered_household_id else "-"
    payload = f"{claims.account_id}.{claims.home_household_id}.{entered}.{claims.issued_at}"
    return f"{payload}.{_platform_mac(payload)}"


def verify_platform_session(value: str, now: int) -> PlatformClaims | None:
    parts = value.split(".")
    if len(parts) != 5:
        return None
    payload, mac = ".".join(parts[:4]), parts[4]
    if not hmac.compare_digest(mac.encode(), _platform_mac(payload).encode()):
        return None
    try:
        claims = PlatformClaims(
            uuid.UUID(parts[0]),
            uuid.UUID(parts[1]),
            None if parts[2] == "-" else uuid.UUID(parts[2]),
            int(parts[3]),
        )
    except ValueError:
        return None
    if not (claims.issued_at <= now < claims.issued_at + settings.PLATFORM_SESSION_HOURS * 3600):
        return None
    return claims


def set_platform_cookie(response: Response, claims: PlatformClaims, now: int) -> None:
    """Strict: the cookie never rides a cross-site navigation. Max-age is what's left."""
    remaining = claims.issued_at + settings.PLATFORM_SESSION_HOURS * 3600 - now
    response.set_cookie(
        PLATFORM_COOKIE,
        sign_platform_session(claims),
        max_age=max(remaining, 0),
        path="/",
        secure=True,
        httponly=True,
        samesite="strict",
    )


def clear_platform_cookie(response: Response) -> None:
    response.delete_cookie(PLATFORM_COOKIE, path="/", secure=True, httponly=True, samesite="strict")


def set_device_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        DEVICE_COOKIE,
        token,
        max_age=settings.DEVICE_IDLE_DAYS * 86400,
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
        max_age=settings.DEVICE_IDLE_DAYS * 86400,
        path="/",
        secure=True,
        httponly=False,
        samesite="lax",
    )


def csrf_matches(cookie_value: str | None, header_value: str | None) -> bool:
    if not cookie_value or not header_value:
        return False
    return hmac.compare_digest(cookie_value.encode(), header_value.encode())
