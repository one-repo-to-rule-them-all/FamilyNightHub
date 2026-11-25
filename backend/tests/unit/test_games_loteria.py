"""Pure Loteria (ADR-0018 amendment 2026-11-26)."""

from __future__ import annotations

import random
import re
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.games import loteria as lo
from app.domain.games.loteria_deck import BY_ID, DECK

seeds = st.integers(min_value=0, max_value=2**64 - 1)
modes = st.sampled_from(list(lo.PATTERNS))

TS_DECK = Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib" / "loteria-deck.ts"


def test_the_deck_has_54_unique_cards_in_order() -> None:
    assert [c.id for c in DECK] == list(range(1, 55))
    assert len({c.name_es for c in DECK}) == 54
    assert len({c.emoji for c in DECK}) == 54
    assert all(c.name_en and c.emoji for c in DECK)
    assert BY_ID[1].name_es == "El Gallo" and BY_ID[54].name_es == "La Rana"


def test_the_frontend_deck_mirrors_the_backend_deck() -> None:
    src = TS_DECK.read_text(encoding="utf-8")
    rows = re.findall(
        r'\{\s*id:\s*(\d+),\s*es:\s*"([^"]+)",\s*en:\s*"([^"]+)",\s*emoji:\s*"([^"]+)"', src
    )
    assert [(int(i), es, en, em) for i, es, en, em in rows] == [
        (c.id, c.name_es, c.name_en, c.emoji) for c in DECK
    ]


@given(seeds)
def test_a_tabla_is_16_distinct_deck_ids(seed: int) -> None:
    tabla = lo.generate_tabla(random.Random(seed))
    assert len(tabla) == 16 and len(set(tabla)) == 16
    assert all(1 <= int(s) <= 54 for s in tabla)
    assert tabla == lo.generate_tabla(random.Random(seed))


@given(seeds)
def test_call_order_is_a_stable_permutation_of_the_deck(seed: int) -> None:
    order = lo.call_order(seed)
    assert sorted(order) == list(range(1, 55)) and order == lo.call_order(seed)


def test_the_pattern_masks() -> None:
    assert len(lo.LINES) == 10
    assert lo.CORNERS == (1 << 0) | (1 << 3) | (1 << 12) | (1 << 15)
    assert lo.CENTER == (1 << 5) | (1 << 6) | (1 << 9) | (1 << 10)
    assert lo.patterns_for("full") == (0xFFFF,)
    with pytest.raises(ValueError):
        lo.patterns_for("x")
    with pytest.raises(ValueError):
        lo.toggle(0, 16)


@given(seeds, st.sets(st.integers(1, 54)), modes)
def test_pattern_and_missing_match_a_brute_force_oracle(
    seed: int, called: set[int], mode: str
) -> None:
    tabla = lo.generate_tabla(random.Random(seed))
    mask = lo.called_mask(tabla, called)
    on = {i for i, s in enumerate(tabla) if int(s) in called}
    assert {i for i in range(16) if mask >> i & 1} == on
    sets: list[set[int]]
    if mode == "line":
        sets = (
            [{r * 4 + c for c in range(4)} for r in range(4)]
            + [{r * 4 + c for r in range(4)} for c in range(4)]
            + [{i * 4 + i for i in range(4)}, {i * 4 + 3 - i for i in range(4)}]
        )
    elif mode == "corners":
        sets = [{0, 3, 12, 15}]
    elif mode == "center":
        sets = [{5, 6, 9, 10}]
    else:
        sets = [set(range(16))]
    won = lo.pattern(mask, mode)
    complete = [s for s in sets if s <= on]
    assert (won is not None) == bool(complete)
    if won is not None:
        assert set(won) in complete
    assert lo.missing(mask, mode) == min(len(s - on) for s in sets)
    assert (lo.missing(mask, mode) == 0) == (won is not None)


def test_toggle_flips_one_bit() -> None:
    assert lo.toggle(0, 5) == 1 << 5 and lo.toggle(1 << 5, 5) == 0
    assert not lo.is_called("x", {1}) and lo.is_called("7", {7})
