"""Gratitude Jar rules (ADR-0018): the reveal order and note cleaning."""

from __future__ import annotations

import random
import uuid

from hypothesis import given
from hypothesis import strategies as st

from app.domain.games import jar


@given(st.sets(st.uuids(), min_size=0, max_size=30), st.integers(min_value=0, max_value=2**64 - 1))
def test_reveal_order_is_a_permutation_independent_of_input_order(
    ids: set[uuid.UUID], seed: int
) -> None:
    listed = list(ids)
    shuffled = listed[:]
    random.Random(seed ^ 1).shuffle(shuffled)
    assert jar.reveal_order(listed, seed) == jar.reveal_order(shuffled, seed)
    assert sorted(jar.reveal_order(listed, seed)) == sorted(listed)


def test_reveal_order_differs_between_seeds() -> None:
    ids = [uuid.UUID(int=i) for i in range(20)]
    assert jar.reveal_order(ids, 1) != jar.reveal_order(ids, 2)


def test_clean_body_collapses_whitespace() -> None:
    assert jar.clean_body("  a \n\t b  ") == "a b"
    assert jar.clean_body("   ") == ""
