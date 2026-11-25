"""Classic host-called bingo (ADR-0018 amendment 2026-11-25, part A). Pure: no I/O, no globals.

A card is 25 numbers as decimal text in row-major order, `FREE` at index 12 when the centre is
free. Column `c` (index % 5) is B, I, N, G or O and holds numbers from its own range of 15.
Thanksgiving's masks, `toggle_mark`, `has_win` and `squares_from_bingo` stay in `bingo.py`.
"""

from __future__ import annotations

import random
from collections.abc import Collection, Sequence

from app.domain.games import bingo
from app.domain.games.bingo import CELLS, CENTER, FREE, SIZE

LETTERS = "BINGO"
PER_COLUMN = 15
MAX_NUMBER = SIZE * PER_COLUMN  # 75


def letter_for(value: int) -> str:
    """B for 1-15, I for 16-30, N, G, O. Raises ValueError outside 1..75."""
    if not 1 <= value <= MAX_NUMBER:
        raise ValueError(f"bingo numbers are 1..{MAX_NUMBER}")
    return LETTERS[(value - 1) // PER_COLUMN]


def label(value: int) -> str:
    """ "B7", "G52"."""
    return f"{letter_for(value)}{value}"


def generate_classic_card(rng: random.Random, free_center: bool = True) -> list[str]:
    """25 squares: five distinct numbers per column from that column's range, FREE at 12."""
    columns = [
        rng.sample(range(c * PER_COLUMN + 1, (c + 1) * PER_COLUMN + 1), SIZE) for c in range(SIZE)
    ]
    squares = [str(columns[i % SIZE][i // SIZE]) for i in range(CELLS)]
    if free_center:
        squares[CENTER] = FREE
    return squares


def call_order(seed: int) -> list[int]:
    """1-75 shuffled by `random.Random(seed)`: the n-th call is `call_order(seed)[n]`."""
    order = list(range(1, MAX_NUMBER + 1))
    random.Random(seed).shuffle(order)
    return order


def called_mask(squares: Sequence[str], called: Collection[int]) -> int:
    """Bit i set when `squares[i]` is FREE or its number has been called."""
    mask = 0
    for i, square in enumerate(squares):
        if square == FREE or (square.isdecimal() and int(square) in called):
            mask |= 1 << i
    return mask


def is_called(square: str, called: Collection[int]) -> bool:
    return square == FREE or (square.isdecimal() and int(square) in called)


def pattern(mask: int, win_mode: str) -> list[int] | None:
    """Indices of the first complete winning pattern in `mask` (a row, column, diagonal, or
    all 25), or None."""
    if win_mode == "blackout":
        return list(range(CELLS)) if mask & bingo.FULL_MASK == bingo.FULL_MASK else None
    for line in bingo.LINES:
        if mask & line == line:
            return [i for i in range(CELLS) if line >> i & 1]
    return None
