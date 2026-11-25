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


# ---- Auto-cycle ----

import json  # noqa: E402
from pathlib import Path  # noqa: E402

_VECTORS = Path(__file__).resolve().parents[3] / "frontend/src/lib/jar-cycle.vectors.json"


def test_cycle_index_matches_the_shared_vectors() -> None:
    for c in json.loads(_VECTORS.read_text(encoding="utf-8"))["cases"]:
        got = jar.cycle_index(c["now"], c["anchor"], c["dwell"], c["count"], c["paused"])
        assert got == c["expected"], c


@given(
    st.floats(0, 1e6),
    st.floats(0, 1e6),
    st.integers(5, 60),
    st.integers(1, 50),
    st.one_of(st.none(), st.integers(0, 100)),
)
def test_cycle_index_is_always_in_range(
    now: float, anchor: float, dwell: int, count: int, paused: int | None
) -> None:
    assert 0 <= jar.cycle_index(now, anchor, dwell, count, paused) < count


def test_pause_helpers() -> None:
    assert jar.can_pause(None) and not jar.can_resume(None)
    assert jar.can_resume(0) and not jar.can_pause(0)


def test_keywords_table() -> None:
    assert jar.keywords("My family") == {"family"}
    assert jar.keywords("Family dinner!") == {"family", "dinner"}
    assert jar.keywords("dinner") == jar.keywords("dinners")
    assert jar.keywords("Café Müller") == {"cafe", "muller"}
    assert jar.keywords("Thankful for my mom") == {"mom"}
    assert jar.keywords("pennies") == {"penny"}
    assert jar.keywords("an of to") == frozenset()


def test_similarity_rules() -> None:
    k = jar.keywords
    assert jar.similar(k("family"), k("my family"))
    assert jar.similar(k("family"), k("family dinner"))
    assert not jar.similar(k("dad"), k("my dad's cooking"))
    assert not jar.similar(k("mom"), k("dad"))
    assert jar.similar(k("turkey stuffing gravy"), k("gravy and stuffing"))
    assert not jar.similar(frozenset(), frozenset())


_NOTES = st.dictionaries(
    st.uuids(),
    st.lists(
        st.sampled_from(["family", "dinner", "mom", "dad", "football", "pie", "home", "friends"]),
        max_size=3,
    ).map(" ".join),
    max_size=25,
)


@given(_NOTES, st.integers(0, 2**64 - 1))
def test_group_order_is_a_permutation_independent_of_input_order(
    notes: dict[uuid.UUID, str], seed: int
) -> None:
    items = list(notes.items())
    other = items[:]
    random.Random(seed ^ 3).shuffle(other)
    out = jar.group_order(items, seed)
    assert sorted(out) == sorted(notes)
    assert out == jar.group_order(other, seed)
    assert out == jar.group_order(items, seed)


def test_group_order_splits_a_large_component_at_the_cap() -> None:
    fam = [(uuid.UUID(int=i), "family dinner") for i in range(1, 9)]
    out = jar.group_order(fam, 5)
    assert sorted(out) == sorted(i for i, _ in fam)
    # One component of 8 is cut into ids 1-6 and 7-8; each chunk is contiguous in the output.
    tail = {uuid.UUID(int=7), uuid.UUID(int=8)}
    assert set(out[:2]) == tail or set(out[-2:]) == tail


def test_group_order_pair_is_adjacent() -> None:
    notes = [
        (uuid.UUID(int=i), b) for i, b in enumerate(["family", "football", "my family", "pie"])
    ]
    for seed in range(20):
        out = jar.group_order(notes, seed)
        assert abs(out.index(uuid.UUID(int=0)) - out.index(uuid.UUID(int=2))) == 1


def test_group_order_differs_between_seeds_and_handles_empty() -> None:
    notes = [(uuid.UUID(int=i), f"w{i}xx yy{i}") for i in range(20)]
    assert jar.group_order(notes, 1) != jar.group_order(notes, 2)
    assert jar.group_order([], 1) == []
