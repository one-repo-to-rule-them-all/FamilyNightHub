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
        has_win(0, "plus")  # type: ignore[arg-type]


# --- more win patterns (ADR-0018 amendment 2026-11-26) ---

from app.domain.games.bingo import CORNERS, STAMPS, X_MASK, patterns  # noqa: E402

NEW_MODES = ["corners", "x", "stamp"]


def test_new_pattern_masks() -> None:
    assert CORNERS.bit_count() == 4 and CORNERS == sum(1 << i for i in (0, 4, 20, 24))
    assert X_MASK.bit_count() == 9 and X_MASK & (1 << CENTER)
    assert len(STAMPS) == 4 and all(s.bit_count() == 4 for s in STAMPS)
    assert sorted(i for i in range(CELLS) if STAMPS[0] >> i & 1) == [0, 1, 5, 6]
    assert sorted(i for i in range(CELLS) if STAMPS[3] >> i & 1) == [18, 19, 23, 24]
    assert patterns("corners") == (CORNERS,) and patterns("x") == (X_MASK,)


@given(masks)
def test_stamp_wins_when_any_one_block_is_full(mask: int) -> None:
    assert has_win(mask, "stamp") == any(mask & s == s for s in STAMPS)
    assert has_win(mask, "corners") == (mask & CORNERS == CORNERS)
    assert has_win(mask, "x") == (mask & X_MASK == X_MASK)


@pytest.mark.parametrize("mode", NEW_MODES)
@given(mask=masks)
def test_squares_from_bingo_matches_brute_force(mode: str, mask: int) -> None:
    pats = {
        "corners": [[0, 4, 20, 24]],
        "x": [[0, 6, 12, 18, 24, 4, 8, 16, 20]],
        "stamp": [[0, 1, 5, 6], [3, 4, 8, 9], [15, 16, 20, 21], [18, 19, 23, 24]],
    }[mode]
    oracle = min(sum(1 for i in p if not mask >> i & 1) for p in pats)
    assert squares_from_bingo(mask, mode) == oracle  # type: ignore[arg-type]
    assert (oracle == 0) == has_win(mask, mode)  # type: ignore[arg-type]


def test_free_centre_counts_toward_x_only() -> None:
    start = initial_mask(True)
    assert squares_from_bingo(start, "x") == 8
    assert squares_from_bingo(start, "corners") == 4
    assert squares_from_bingo(start, "stamp") == 4
