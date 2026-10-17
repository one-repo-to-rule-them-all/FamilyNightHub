"""Credential rules (ADR-0014): usernames, account passwords, person PINs. Pure.

Passwords follow NIST SP 800-63B: a length floor and a denylist, no composition rules.
Each check returns the normalized value or raises ValueError with a user-facing reason,
so Pydantic validators and the CLI share one rule set.
"""

from __future__ import annotations

import re

USERNAME = re.compile(r"^[a-z0-9._-]{3,32}$")
PIN = re.compile(r"^[0-9]{6}$")
PASSWORD_MIN = 12
PASSWORD_MAX = 256
# How many wrong PINs lock a profile until an admin resets it.
PIN_MAX_ATTEMPTS = 5

# Common passwords that pass the length floor. Short on purpose: the floor does most of the
# work; this catches the handful people reach for when told "at least 12 characters".
_DENYLIST = frozenset(
    {
        "123456789012",
        "1234567890123",
        "12345678901234",
        "123456789abc",
        "1q2w3e4r5t6y",
        "aaaaaaaaaaaa",
        "abc123abc123",
        "abcdefghijkl",
        "familynight1",
        "familymovienight",
        "iloveyou1234",
        "letmein12345",
        "movienight12",
        "movienight123",
        "password1234",
        "password12345",
        "password123!",
        "passwordpassword",
        "qwerty123456",
        "qwertyuiop12",
        "qwertyuiopasdf",
        "welcome12345",
    }
)


def normalize_username(value: str) -> str:
    """Case-insensitive: stored and compared lowercase. Never contains '@', so a login
    identifier with '@' is always an email."""
    username = value.strip().lower()
    if not USERNAME.match(username):
        raise ValueError("username must be 3-32 characters of a-z, 0-9, '.', '_' or '-'")
    return username


def check_password(password: str, *, username: str | None = None, email: str | None = None) -> str:
    """The password unchanged (no trimming: spaces are characters), or ValueError."""
    if len(password) < PASSWORD_MIN:
        raise ValueError(f"password must be at least {PASSWORD_MIN} characters")
    if len(password) > PASSWORD_MAX:
        raise ValueError(f"password must be at most {PASSWORD_MAX} characters")
    folded = password.casefold()
    if len(set(folded)) == 1 or folded in _DENYLIST:
        raise ValueError("that password is too easy to guess")
    if any(own and folded == own.casefold() for own in (username, email)):
        raise ValueError("password must not be your username or email")
    return password


def check_pin(value: str) -> str:
    if not PIN.match(value):
        raise ValueError("PIN must be exactly 6 digits")
    return value


def attempts_left(failed_attempts: int) -> int:
    return max(PIN_MAX_ATTEMPTS - failed_attempts, 0)


def locks_after(failed_attempts: int) -> bool:
    """True when this many consecutive wrong PINs locks the profile."""
    return failed_attempts >= PIN_MAX_ATTEMPTS
