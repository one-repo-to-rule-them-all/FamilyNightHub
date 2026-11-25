"""Scattergories validation and host review (ADR-0018 amendment 2026-11-25, part C)."""

import json
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.games.scatter import (
    answer_points,
    dedupe_key,
    is_valid,
    matches_letter,
    normalize,
    one_edit_apart,
    review,
    score_round,
)

VECTORS = json.loads(
    (Path(__file__).parents[1] / "vectors" / "scatter_normalize.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("v", VECTORS["normalize"], ids=lambda v: repr(v["text"]))
def test_normalize_vectors(v):
    assert normalize(v["text"]) == v["key"]


@pytest.mark.parametrize("v", VECTORS["starts_with"], ids=lambda v: repr(v["text"]))
def test_starts_with_vectors(v):
    assert matches_letter(v["text"], v["letter"]) is v["ok"]


@pytest.mark.parametrize("v", VECTORS["dedupe"], ids=lambda v: repr(v["text"]))
def test_dedupe_vectors(v):
    assert dedupe_key(v["text"]) == v["key"]


def test_dedupe_glasses_and_tomatoes():
    assert dedupe_key("glasses") == dedupe_key("glass") == "glass"
    assert dedupe_key("tomatoes") == dedupe_key("tomato")


@given(st.text())
def test_dedupe_idempotent_and_function_of_normalize(text):
    key = dedupe_key(text)
    assert dedupe_key(key) == key
    assert dedupe_key(normalize(text)) == key


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("pumkin", "pumpkin", True),
        ("pumpkin", "pumkin", True),
        ("pumpkin", "pumpkon", True),
        ("pumpkin", "pumpkin", False),
        ("pumpkin", "pumpkinnn", False),
        ("abcd", "abdc", False),
        ("abc", "abcde", False),
    ],
)
def test_one_edit_apart(a, b, expected):
    assert one_edit_apart(a, b) is expected


def test_plural_pair_scores_zero_and_accept_separates():
    answers = [("a", 0, "Potatoes"), ("b", 0, "Potato")]
    assert score_round(answers, {}, letter="P") == {"a": 0, "b": 0}
    assert score_round(answers, {("b", 0): "accepted"}, letter="P") == {"a": 1, "b": 1}
    assert score_round(answers, {("a", 0): "accepted"}, letter="P") == {"a": 1, "b": 1}


def test_accept_never_separates_exact_duplicates():
    answers = [("a", 0, "Potato"), ("b", 0, "potato!")]
    assert score_round(answers, {("a", 0): "accepted"}, letter="P") == {"a": 0, "b": 0}
    both = {("a", 0): "accepted", ("b", 0): "accepted"}
    assert score_round(answers, both, letter="P") == {"a": 0, "b": 0}


def test_typo_pair_scores_as_written():
    answers = [("a", 0, "Pumkin pie"), ("b", 0, "Pumpkin pie")]
    assert score_round(answers, {}, letter="P") == {"a": 1, "b": 1}


def test_accepting_does_not_rescue_wrong_letter():
    assert score_round([("a", 0, "Apple")], {("a", 0): "accepted"}, letter="P") == {"a": 0}


def kinds(items):
    return [(i.kind, i.category_index, i.answers) for i in items]


def test_review_buckets():
    answers = [
        ("a", 0, "Potatoes"),
        ("b", 0, "Potato"),  # near duplicate
        ("c", 0, "Pizza"),  # auto accepted
        ("d", 0, "Apple"),  # wrong letter
        ("a", 1, "Pie"),
        ("b", 1, "pie"),  # exact duplicate
        ("c", 1, "Pb"),  # short
        ("d", 1, "Pumkin pie"),
        ("e", 1, "Pumpkin pie"),  # typo pair
        ("a", 2, "Pear"),
        ("b", 2, "Peach"),  # host rejected
    ]
    r = review(answers, {("b", 2): "rejected"}, letter="P")
    assert kinds(r.needs_decision) == [
        ("near_duplicate", 0, (("a", 0), ("b", 0))),
        ("near_duplicate", 1, (("d", 1), ("e", 1))),
        ("short", 1, (("c", 1),)),
    ]
    assert kinds(r.informational) == [
        ("auto_rejected_letter", 0, (("d", 0),)),
        ("duplicate", 1, (("a", 1), ("b", 1))),
        ("host_rejected", 2, (("b", 2),)),
    ]
    assert r.auto_accepted == (("a", 2), ("c", 0))
    total = sum(len(i.answers) for i in r.needs_decision + r.informational) + len(r.auto_accepted)
    assert total == len(answers)


def test_review_keeps_decided_items_visible():
    answers = [("a", 0, "Potatoes"), ("b", 0, "Potato")]
    decided = review(answers, {("a", 0): "accepted"}, letter="P")
    assert [i.kind for i in decided.needs_decision] == ["near_duplicate"]
    shorty = review([("a", 0, "Pb")], {("a", 0): "rejected"}, letter="P")
    assert [i.kind for i in shorty.needs_decision] == ["short"]


def test_review_typo_needs_six_characters():
    assert review([("a", 0, "Pumpk"), ("b", 0, "Pumpl")], {}, letter="P").needs_decision == ()
    assert len(review([("a", 0, "Pumpki"), ("b", 0, "Pumpko")], {}, letter="P").needs_decision) == 1


wide_texts = st.sampled_from(
    ["pie", "Pies", "pumpkin", "Pumkin", "potato", "potatoes", "Pb", "apple", "Peach", "peaches"]
)
wide_lists = st.lists(
    st.tuples(st.sampled_from(["p1", "p2", "p3", "p4"]), st.integers(0, 2), wide_texts),
    unique_by=lambda a: (a[0], a[1]),
    max_size=12,
)
verdict_choice = st.sampled_from([None, "accepted", "rejected"])


@given(wide_lists, st.data())
def test_review_partitions_every_answer_once(answers, data):
    verdicts = {(p, c): data.draw(verdict_choice) for p, c, _ in answers}
    r = review(answers, verdicts, letter="P")
    seen = [k for i in r.needs_decision + r.informational for k in i.answers]
    seen += list(r.auto_accepted)
    assert sorted(seen) == sorted((p, c) for p, c, _ in answers)
    texts = {(p, c): t for p, c, t in answers}
    for item in r.needs_decision:
        assert item.kind in {"near_duplicate", "short"}
        assert all(matches_letter(texts[k], "P") for k in item.answers)


@given(wide_lists, st.data(), st.randoms(use_true_random=False))
def test_scoring_and_review_independent_of_order(answers, data, rnd):
    verdicts = {(p, c): data.draw(verdict_choice) for p, c, _ in answers}
    shuffled = list(answers)
    rnd.shuffle(shuffled)
    assert answer_points(answers, verdicts, letter="P") == answer_points(
        shuffled, verdicts, letter="P"
    )
    assert review(answers, verdicts, letter="P") == review(shuffled, verdicts, letter="P")


@given(wide_lists)
def test_accepting_everything_only_merges_exact_duplicates(answers):
    verdicts = {(p, c): "accepted" for p, c, _ in answers}
    pts = answer_points(answers, verdicts, letter="P")
    for person, cat, text in answers:
        if is_valid(text, "P", "accepted"):
            exact = [a for a in answers if a[1] == cat and normalize(a[2]) == normalize(text)]
            assert pts[(person, cat)] == int(len(exact) == 1)
