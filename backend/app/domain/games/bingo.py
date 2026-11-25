"""Thanksgiving bingo (ADR-0018 section 4). Pure: no I/O, no globals; the RNG is injected.

A card is 25 squares in row-major order. A mark mask is an int with bit i set when
square i is marked. With a free centre, index 12 holds FREE and is always marked.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from typing import Literal

WinMode = Literal["line", "blackout", "corners", "x", "stamp"]
WIN_MODE_VALUES: tuple[str, ...] = ("line", "blackout", "corners", "x", "stamp")

SIZE = 5
CELLS = SIZE * SIZE
CENTER = CELLS // 2
FREE = "FREE"
FULL_MASK = (1 << CELLS) - 1
CENTER_BIT = 1 << CENTER


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
CORNERS: int = _mask([0, SIZE - 1, CELLS - SIZE, CELLS - 1])
# Both diagonals together: the letter X (9 squares, the centre is shared).
X_MASK: int = LINES[-2] | LINES[-1]
# A 2x2 "postage stamp" block in any one corner of the card.
STAMPS: tuple[int, ...] = tuple(
    _mask([(r + dr) * SIZE + c + dc for dr in (0, 1) for dc in (0, 1)])
    for r in (0, SIZE - 2)
    for c in (0, SIZE - 2)
)


def generate_card(pool: Sequence[str], rng: random.Random, free_center: bool = True) -> list[str]:
    """25 squares: distinct draws without replacement, FREE at index 12 when free_center."""
    need = CELLS - 1 if free_center else CELLS
    unique = list(dict.fromkeys(pool))
    if len(unique) < need:
        raise ValueError(f"pool needs at least {need} distinct squares")
    drawn = rng.sample(unique, need)
    if free_center:
        drawn.insert(CENTER, FREE)
    return drawn


def initial_mask(free_center: bool = True) -> int:
    return CENTER_BIT if free_center else 0


def toggle(mask: int, index: int) -> int:
    """Flip one square's bit. Raises ValueError for an index outside 0..24."""
    if not 0 <= index < CELLS:
        raise ValueError(f"index must be 0..{CELLS - 1}")
    return mask ^ (1 << index)


def toggle_mark(mask: int, index: int, free_center: bool = True) -> int:
    """Like `toggle`, but the free centre cannot be unmarked."""
    if free_center and index == CENTER:
        return mask | CENTER_BIT
    return toggle(mask, index)


def patterns(win_mode: WinMode) -> tuple[int, ...]:
    """The winning masks for a mode (any one of them wins)."""
    return _patterns(win_mode)


def _patterns(win_mode: WinMode) -> tuple[int, ...]:
    if win_mode == "line":
        return LINES
    if win_mode == "blackout":
        return (FULL_MASK,)
    if win_mode == "corners":
        return (CORNERS,)
    if win_mode == "x":
        return (X_MASK,)
    if win_mode == "stamp":
        return STAMPS
    raise ValueError(f"unknown win_mode {win_mode!r}")


def has_win(mask: int, win_mode: WinMode) -> bool:
    return any(mask & p == p for p in _patterns(win_mode))


def squares_from_bingo(mask: int, win_mode: WinMode) -> int:
    """Fewest unmarked squares in any one winning pattern (0 means won)."""
    return min((p & ~mask).bit_count() for p in _patterns(win_mode))
