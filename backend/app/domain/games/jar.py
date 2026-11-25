"""Gratitude Jar rules (ADR-0018): the reveal order and the note rules. Pure, no I/O.

The order is a seeded shuffle over the note ids in sorted order, so neither insertion order
nor read order can change it, and a test can pin it with the seed (like the voting
tie-break, ADR-0006).
"""

from __future__ import annotations

import random
import uuid
from collections.abc import Iterable

MAX_NOTE_LENGTH = 280


def clean_body(raw: str) -> str:
    """Whitespace collapsed and trimmed. May come back empty; the caller refuses that."""
    return " ".join(raw.split())


def reveal_order(note_ids: Iterable[uuid.UUID], seed: int) -> list[uuid.UUID]:
    """The notes in the order the host will show them."""
    ordered = sorted(note_ids)
    random.Random(seed).shuffle(ordered)
    return ordered
