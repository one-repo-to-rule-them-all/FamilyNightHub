"""argon2id for account passwords and person PINs (ADR-0014).

Parameters are the OWASP minimum (m = 19 MiB, t = 2, p = 1), not argon2-cffi's 64 MiB
default: the API machine has 512 MB and a room full of phones may claim at once. Hashing
is CPU-bound, so it runs in a worker thread.

PINs have only 10^6 values. Before hashing they are peppered and bound to the person:
argon2id(HMAC(DEVICE_TOKEN_PEPPER, "pin:{person_id}:{pin}")). A database dump without the
pepper cannot test a single guess, and a hash copied to another person never verifies.
The attempt limit (people_service) is what makes them safe online.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import uuid

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import settings

_hasher = PasswordHasher(time_cost=2, memory_cost=19 * 1024, parallelism=1)

# Verified against when there is no real hash (unknown login, no password yet), so every
# failed login costs the same time.
_DUMMY_HASH = _hasher.hash("fnh-dummy-password-for-constant-time")


def _pin_message(person_id: uuid.UUID, pin: str) -> str:
    return hmac.new(
        settings.DEVICE_TOKEN_PEPPER.encode(), f"pin:{person_id}:{pin}".encode(), hashlib.sha256
    ).hexdigest()


def _verify(stored: str | None, secret: str) -> bool:
    try:
        return _hasher.verify(stored or _DUMMY_HASH, secret) and stored is not None
    except (VerificationError, InvalidHashError):
        return False


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(_hasher.hash, password)


async def verify_password(stored: str | None, password: str) -> bool:
    """False for a wrong password and for no stored hash; same cost either way."""
    return await asyncio.to_thread(_verify, stored, password)


async def hash_pin(person_id: uuid.UUID, pin: str) -> str:
    return await asyncio.to_thread(_hasher.hash, _pin_message(person_id, pin))


async def verify_pin(stored: str, person_id: uuid.UUID, pin: str) -> bool:
    return await asyncio.to_thread(_verify, stored, _pin_message(person_id, pin))


def needs_rehash(stored: str) -> bool:
    """True when `stored` was made with other parameters; rehash after a good check."""
    return _hasher.check_needs_rehash(stored)
