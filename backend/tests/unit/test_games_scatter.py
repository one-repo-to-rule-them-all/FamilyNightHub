import random

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.games.scatter import (
    EXCLUDED_LETTERS,
    LETTERS,
    answer_points,
    draw_categories,
    draw_letter,
    is_valid,
    normalize,
    score_round,
)
from app.domain.games.scatter_categories import CATEGORIES


def test_pool_is_big_and_unique():
    assert len(CATEGORIES) >= 40
    assert len(set(CATEGORIES)) == len(CATEGORIES)


def test_letters_exclude_set():
    assert LETTERS and not set(LETTERS) & EXCLUDED_LETTERS


@given(st.integers())
def test_letter_never_excluded(seed):
    letter = draw_letter(random.Random(seed))
    assert letter.isalpha() and letter not in EXCLUDED_LETTERS


def test_draw_categories():
    rng = random.Random(1)
    got = draw_categories(CATEGORIES, rng, 12)
    assert len(got) == len(set(got)) == 12 and set(got) <= set(CATEGORIES)
    assert draw_categories(CATEGORIES, rng, 0) == []
    assert draw_categories(CATEGORIES, random.Random(5), 5) == draw_categories(
        CATEGORIES, random.Random(5), 5
    )
    for bad in (-1, len(CATEGORIES) + 1):
        with pytest.raises(ValueError):
            draw_categories(CATEGORIES, rng, bad)


def test_normalize_examples():
    assert normalize("  The   Sweet-Potato Pie! ") == "sweetpotato pie"
    assert normalize("Café") == "cafe"
    assert normalize("An apple") == "apple"
    assert normalize("the") == "the"
    assert normalize("the the pie") == "pie"
    assert normalize("") == ""


@given(st.text())
def test_normalize_idempotent(text):
    once = normalize(text)
    assert normalize(once) == once


def test_is_valid():
    assert is_valid("The Apple pie", "a", None)
    assert is_valid("apple", "A", "accepted")
    assert not is_valid("apple", "A", "rejected")
    assert not is_valid("banana", "A", None)
    assert not is_valid("", "A", None)


def test_score_basic():
    answers = [
        ("p1", 0, "Apple"),
        ("p2", 0, "an apple"),  # duplicate of p1 after normalisation
        ("p3", 0, "Avocado"),
        ("p1", 1, "Apricot"),
        ("p2", 1, "Banana"),  # wrong letter
    ]
    assert score_round(answers, {}, letter="A") == {"p1": 1, "p2": 0, "p3": 1}
    assert score_round([], {}, letter="A") == {}


def test_rejecting_duplicate_frees_the_other():
    answers = [("p1", 0, "Apple"), ("p2", 0, "apple")]
    assert score_round(answers, {}, letter="A") == {"p1": 0, "p2": 0}
    assert score_round(answers, {("p2", 0): "rejected"}, letter="A") == {"p1": 1, "p2": 0}


texts = st.sampled_from(["apple", "Apple", "the apple", "avocado", "ham", "Ant"])
answer_lists = st.lists(
    st.tuples(st.sampled_from(["p1", "p2", "p3", "p4"]), st.integers(0, 2), texts),
    unique_by=lambda a: (a[0], a[1]),
    max_size=12,
)


@given(answer_lists, st.randoms(use_true_random=False))
def test_score_independent_of_order(answers, rnd):
    shuffled = list(answers)
    rnd.shuffle(shuffled)
    assert score_round(answers, {}, letter="A") == score_round(shuffled, {}, letter="A")


@given(answer_lists)
def test_duplicates_never_score(answers):
    scores = score_round(answers, {}, letter="A")
    total = sum(scores.values())
    unique_valid = 0
    for _person, cat, text in answers:
        same = [a for a in answers if a[1] == cat and normalize(a[2]) == normalize(text)]
        if len(same) == 1 and is_valid(text, "A", None):
            unique_valid += 1
    assert total == unique_valid


def test_answer_points_per_answer():
    answers = [("a", 0, "Apple"), ("b", 0, "an apple"), ("a", 1, "Acorn"), ("b", 1, "Bean")]
    pts = answer_points(answers, {}, letter="A")
    assert pts == {("a", 0): 0, ("b", 0): 0, ("a", 1): 1, ("b", 1): 0}
    assert sum(pts.values()) == sum(score_round(answers, {}, letter="A").values())
