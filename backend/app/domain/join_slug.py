"""Join slugs: the household's fridge-QR door, `/j/{slug}` (ADR-0002). Pure: no I/O.

A rotated slug is three dash-separated groups of four from the night-code alphabet,
lowercased (no 0/o, 1/i/l), e.g. `k7m2-x9pq-r4tw`: readable aloud, and 31^12 (~2^59) of
them, so an old QR cannot be guessed back into a working one. The slug is a door, not a
key; joining still needs the night code or a host.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable

from app.domain.night_code import ALPHABET as _CODE_ALPHABET

ALPHABET = _CODE_ALPHABET.lower()
GROUPS = 3
GROUP_LENGTH = 4


def generate(choice: Callable[[str], str] = secrets.choice) -> str:
    """A fresh slug. `choice` is injectable so tests are deterministic."""
    return "-".join("".join(choice(ALPHABET) for _ in range(GROUP_LENGTH)) for _ in range(GROUPS))
