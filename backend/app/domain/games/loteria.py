"""Lotería (ADR-0018 amendment 2026-11-26). Pure: no I/O, no globals; the RNG is injected.

A tabla is 16 distinct deck card ids in row-major 4 x 4 order, stored as decimal text. A mark
mask has bit `i` set when square `i` is marked; there is no free square. The host draws from a
seeded shuffle of 1-54 and checks a spoken claim against the CALLED set, never the taps.
"""

from __future__ import annotations

import random
from collections.abc import Collection, Sequence
from typing import Literal

from app.domain.games.loteria_deck import DECK

Pattern = Literal["line", "corners", "center", "full"]
PATTERNS: tuple[Pattern, ...] = ("line", "corners", "center", "full")

SIZE = 4
CELLS = SIZE * SIZE
DECK_SIZE = len(DECK)  # 54
FULL_MASK = (1 << CELLS) - 1


def _mask(indices: Sequence[int]) -> int:
    m = 0
    for i in indices:
        m |= 1 << i
    return m


LINES: tuple[int, ...] = (
    *(_mask([r * SIZE + c for c in range(SIZE)]) for r in range(SIZE)),
    *(_mask([r * SIZE + c for r in range(SIZE)]) for c in range(SIZE)),
    _mask([i * SIZE + i for i in range(SIZE)]),
    _mask([i * SIZE + (SIZE - 1 - i) for i in range(SIZE)]),
)
CORNERS = _mask([0, SIZE - 1, CELLS - SIZE, CELLS - 1])
CENTER = _mask([5, 6, 9, 10])


def patterns_for(mode: str) -> tuple[int, ...]:
    if mode == "line":
        return LINES
    if mode == "corners":
        return (CORNERS,)
    if mode == "center":
        return (CENTER,)
    if mode == "full":
        return (FULL_MASK,)
    raise ValueError(f"unknown pattern {mode!r}")


def generate_tabla(rng: random.Random) -> list[str]:
    """16 distinct deck ids, as text, in row-major order."""
    return [str(i) for i in rng.sample(range(1, DECK_SIZE + 1), CELLS)]


def call_order(seed: int) -> list[int]:
    """1-54 shuffled by `random.Random(seed)`: the n-th call is `call_order(seed)[n]`."""
    order = list(range(1, DECK_SIZE + 1))
    random.Random(seed).shuffle(order)
    return order


def is_called(square: str, called: Collection[int]) -> bool:
    return square.isdecimal() and int(square) in called


def called_mask(squares: Sequence[str], called: Collection[int]) -> int:
    """Bit i set when the card on square i has been called."""
    m = 0
    for i, sq in enumerate(squares):
        if is_called(sq, called):
            m |= 1 << i
    return m


def toggle(mask: int, index: int) -> int:
    if not 0 <= index < CELLS:
        raise ValueError(f"index must be 0..{CELLS - 1}")
    return mask ^ (1 << index)


def pattern(mask: int, mode: str) -> list[int] | None:
    """Indices of the first complete pattern in `mask`, or None."""
    for p in patterns_for(mode):
        if mask & p == p:
            return [i for i in range(CELLS) if p >> i & 1]
    return None


def missing(mask: int, mode: str) -> int:
    """Fewest squares still needed in any one pattern (0 means complete)."""
    return min((p & ~mask).bit_count() for p in patterns_for(mode))
