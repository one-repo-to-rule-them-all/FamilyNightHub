"""Night reel rules (ADR-0018 amendment "Night reel"): the window and the stable shuffle. Pure.

The reel's order must not jump when a TV refetches or when one new slide appears, so an item's
place is its hash under the seed (not a shuffle of the whole list): adding an item inserts it
somewhere without reordering the rest, and the same seed gives the same order from any input
order. The seed is derived per household and UTC day unless a test pins it.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Literal

Window = Literal["tonight", "all"]

DWELL_SECONDS = 12
TONIGHT_HOURS = 12
MAX_QUOTES = 200
MAX_PHOTOS = 60
LEADERBOARD_TOP = 5


def window_since(window: Window, now: datetime) -> datetime | None:
    """The oldest moment a slide may come from; None for `all` (no lower bound)."""
    return None if window == "all" else now - timedelta(hours=TONIGHT_HOURS)


def anchor_for(now: datetime) -> datetime:
    """A fixed point of the cycle: the start of the UTC day, so it never moves on a refetch."""
    utc = now.astimezone(UTC)
    return utc.replace(hour=0, minute=0, second=0, microsecond=0)


def reel_seed(household_id: uuid.UUID, now: datetime) -> int:
    """The default seed: stable for a household for the UTC day, different next year."""
    day = anchor_for(now).date().isoformat()
    digest = hashlib.sha256(f"{household_id}:{day}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


def order_ids(ids: Iterable[str], seed: int) -> list[str]:
    """`ids` in the seeded order. Input order never matters; duplicates collapse."""
    unique = sorted(set(ids))
    return sorted(unique, key=lambda i: (hashlib.sha256(f"{seed}:{i}".encode()).digest(), i))
