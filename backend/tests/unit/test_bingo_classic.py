"""Pure classic bingo (ADR-0018 amendment, part A)."""

from __future__ import annotations

import random

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.games import bingo
from app.domain.games import bingo_classic as bc

seeds = st.integers(min_value=0, max_value=2**64 - 1)


@given(seeds, st.booleans())
def test_card_columns_and_distinct_numbers(seed: int, free: bool) -> None:
    card = bc.generate_classic_card(random.Random(seed), free)
    assert len(card) == 25
    for c in range(5):
        col = [card[r * 5 + c] for r in range(5)]
        nums = [int(x) for x in col if x != bingo.FREE]
        assert len(nums) == len(set(nums))
        assert all(c * 15 < n <= (c + 1) * 15 for n in nums)
    assert (card[12] == bingo.FREE) is free
    assert sum(1 for x in card if x == bingo.FREE) == (1 if free else 0)


@given(seeds)
def test_call_order_is_a_stable_permutation(seed: int) -> None:
    order = bc.call_order(seed)
    assert sorted(order) == list(range(1, 76))
    assert order == bc.call_order(seed)


@given(seeds, st.booleans(), st.sets(st.integers(1, 75)), st.sampled_from(["line", "blackout"]))
def test_called_mask_matches_a_brute_force_oracle(
    seed: int, free: bool, called: set[int], mode: str
) -> None:
    card = bc.generate_classic_card(random.Random(seed), free)
    mask = bc.called_mask(card, called)
    expected = [i for i, s in enumerate(card) if s == "FREE" or int(s) in called]
    assert [i for i in range(25) if mask >> i & 1] == expected
    rows = [[r * 5 + c for c in range(5)] for r in range(5)]
    cols = [[r * 5 + c for r in range(5)] for c in range(5)]
    diags = [[i * 5 + i for i in range(5)], [i * 5 + 4 - i for i in range(5)]]
    lines = rows + cols + diags
    got = bc.pattern(mask, mode)
    if mode == "line":
        oracle = any(all(i in expected for i in ln) for ln in lines)
    else:
        oracle = len(expected) == 25
    assert bingo.has_win(mask, mode) is oracle  # type: ignore[arg-type]
    assert (got is not None) is oracle
    if got is not None:
        assert all(i in expected for i in got)


def test_letters_and_labels() -> None:
    assert [bc.letter_for(v) for v in (1, 15, 16, 30, 31, 45, 46, 60, 61, 75)] == list("BBIINNGGOO")
    assert bc.label(7) == "B7"
    assert bc.label(52) == "G52"
    for bad in (0, 76, -1):
        with pytest.raises(ValueError):
            bc.letter_for(bad)


def test_is_called_and_non_numeric_square() -> None:
    assert bc.is_called("FREE", set())
    assert bc.is_called("7", {7})
    assert not bc.is_called("7", {8})
    assert not bc.is_called("Turkey", {7})
    assert bc.called_mask(["Turkey"], {7}) == 0


def test_pattern_picks_first_line() -> None:
    assert bc.pattern(0, "line") is None
    assert bc.pattern(0b11111, "line") == [0, 1, 2, 3, 4]
    assert bc.pattern(bingo.FULL_MASK, "blackout") == list(range(25))
    assert bc.pattern(0b11111, "blackout") is None
