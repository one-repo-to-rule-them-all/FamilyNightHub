import random

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.games.bingo import (
    CELLS,
    CENTER,
    FREE,
    FULL_MASK,
    LINES,
    generate_card,
    has_win,
    initial_mask,
    squares_from_bingo,
    toggle,
    toggle_mark,
)
from app.domain.games.bingo_pool import THANKSGIVING_POOL

masks = st.integers(min_value=0, max_value=FULL_MASK)
modes = st.sampled_from(["line", "blackout"])


def oracle_win(mask, mode):
    marked = {i for i in range(CELLS) if mask >> i & 1}
    if mode == "blackout":
        return len(marked) == CELLS
    rows = [{r * 5 + c for c in range(5)} for r in range(5)]
    cols = [{r * 5 + c for r in range(5)} for c in range(5)]
    diags = [{i * 5 + i for i in range(5)}, {i * 5 + 4 - i for i in range(5)}]
    return any(line <= marked for line in rows + cols + diags)


def test_pool_quality():
    assert len(THANKSGIVING_POOL) >= 60
    assert len(set(THANKSGIVING_POOL)) == len(THANKSGIVING_POOL)
    assert all(0 < len(s) <= 40 for s in THANKSGIVING_POOL)


def test_lines_are_12_distinct_masks_of_5():
    assert len(LINES) == 12 == len(set(LINES))
    assert all(m.bit_count() == 5 for m in LINES)


@given(st.integers(), st.booleans())
def test_card_distinct_from_pool(seed, free):
    card = generate_card(THANKSGIVING_POOL, random.Random(seed), free)
    assert len(card) == 25
    body = [s for i, s in enumerate(card) if not (free and i == CENTER)]
    assert len(set(body)) == len(body) == (24 if free else 25)
    assert set(body) <= set(THANKSGIVING_POOL)
    assert (card[CENTER] == FREE) == free


def test_card_deterministic_and_dedups_pool():
    a = generate_card(THANKSGIVING_POOL, random.Random(1))
    assert a == generate_card(THANKSGIVING_POOL, random.Random(1))
    dup = [*THANKSGIVING_POOL, *THANKSGIVING_POOL]
    assert len(set(generate_card(dup, random.Random(2)))) == 25


def test_card_small_pool_rejected():
    with pytest.raises(ValueError):
        generate_card(["a"] * 30, random.Random(0))
    with pytest.raises(ValueError):
        generate_card([str(i) for i in range(24)], random.Random(0), free_center=False)


def test_initial_mask():
    assert initial_mask(True) == 1 << CENTER
    assert initial_mask(False) == 0


@given(masks, st.integers(0, CELLS - 1))
def test_toggle_twice_identity(mask, i):
    assert toggle(toggle(mask, i), i) == mask
    start = mask | 1 << CENTER
    assert toggle_mark(toggle_mark(start, i), i) == start


def test_toggle_bounds_and_free_centre():
    for bad in (-1, CELLS):
        with pytest.raises(ValueError):
            toggle(0, bad)
    start = initial_mask(True)
    assert toggle_mark(start, CENTER, True) == start
    assert toggle_mark(0, CENTER, False) == 1 << CENTER


@given(masks, modes)
def test_has_win_matches_oracle(mask, mode):
    assert has_win(mask, mode) == oracle_win(mask, mode)


@given(masks, modes)
def test_squares_from_bingo_zero_iff_win(mask, mode):
    n = squares_from_bingo(mask, mode)
    assert (n == 0) == has_win(mask, mode)
    assert 0 <= n <= (CELLS if mode == "blackout" else 5)


def test_known_values():
    assert squares_from_bingo(0, "line") == 5
    assert squares_from_bingo(initial_mask(True), "line") == 4
    assert squares_from_bingo(0, "blackout") == 25
    assert squares_from_bingo(FULL_MASK, "blackout") == 0
    assert has_win(LINES[0], "line") and not has_win(LINES[0], "blackout")


def test_unknown_mode():
    with pytest.raises(ValueError):
        has_win(0, "x")  # type: ignore[arg-type]
