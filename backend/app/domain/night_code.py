"""Night codes: the six-character key shown on the TV (ADR-0002). Pure: no I/O.

The alphabet drops 0/O, 1/I/L so a code read off a TV across the room can't be misread;
31 symbols x 6 positions = 887,503,681 codes. Only a peppered hash is stored
(`sessions.night_code_hash`, see app/core/security.py).
"""

from __future__ import annotations

import secrets
from collections.abc import Callable

ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
LENGTH = 6

# ADR-0002 (amended): people can join while the TV shows the lobby, through the night,
# and not once it is closed.
JOINABLE_STATUSES = frozenset({"draft", "voting", "revealed", "tonight"})

_SEPARATORS = str.maketrans("", "", " -_")


def generate(choice: Callable[[str], str] = secrets.choice) -> str:
    """A fresh code. `choice` is injectable so tests are deterministic."""
    return "".join(choice(ALPHABET) for _ in range(LENGTH))


def normalize(raw: str) -> str | None:
    """Canonical form of what someone typed, or None if it cannot be a code.

    Case-insensitive, and ignores spaces, dashes and underscores ("abc-234" works).
    """
    code = raw.translate(_SEPARATORS).upper()
    if len(code) != LENGTH or any(ch not in ALPHABET for ch in code):
        return None
    return code


def accepts_joins(status: str) -> bool:
    return status in JOINABLE_STATUSES
