"""Top-3 tally and tie-break (ADR-0006): worked examples plus Hypothesis properties."""

from __future__ import annotations

import random
from collections.abc import Sequence

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.session_state import SessionRuleError
from app.domain.voting import METHODS, top3
from app.domain.voting.base import MAX_SEED, Ballot, BallotError

ABCD = ["A", "B", "C", "D"]


def order(ranking: top3.Ranking) -> list[str]:
    return [p.option_id for p in ranking.placements]


# --- Worked examples -----------------------------------------------------------------


def test_points_decide_when_there_is_no_tie() -> None:
    ballots = [{"A": 1, "B": 2, "C": 3}, {"A": 1, "C": 2}, {"B": 1}]
    r = top3.tally(ABCD, ballots, seed=7)
    assert r.ballot_size == 3 and r.ballot_count == 3 and r.method == "top3"
    assert [(p.option_id, p.score, p.first_places, p.place) for p in r.placements] == [
        ("A", 6, 2, 1),
        ("B", 5, 1, 2),
        ("C", 3, 0, 3),
        ("D", 0, 0, 4),
    ]
    assert (r.winner, r.tie_group, r.tiebreak) == ("A", ("A",), "none")


def test_first_place_votes_break_a_points_tie() -> None:
    # k = 2: A = 2 + 2 (two firsts), B = 1 + 1 + 2 (one first).
    ballots = [{"A": 1, "B": 2}, {"A": 1, "B": 2}, {"B": 1}]
    r = top3.tally(["A", "B", "C"], ballots, seed=0)
    assert order(r) == ["A", "B", "C"]
    assert (r.tie_group, r.tiebreak) == (("A", "B"), "first_places")


def test_head_to_head_breaks_a_points_and_firsts_tie() -> None:
    # A and B: 3 points and one first each; A is above B on two ballots, B above A on one.
    ballots = [{"A": 1, "B": 2}, {"B": 1}, {"C": 1, "A": 2}]
    r = top3.tally(["A", "B", "C"], ballots, seed=0)
    assert [(p.option_id, p.score) for p in r.placements] == [("A", 3), ("B", 3), ("C", 2)]
    assert (r.tie_group, r.tiebreak) == (("A", "B"), "head_to_head")


def test_a_cycle_falls_through_to_the_seeded_lottery() -> None:
    # Rock-paper-scissors: equal points, equal firsts, one head-to-head win each.
    ballots = [{"A": 1, "B": 2}, {"B": 1, "C": 2}, {"C": 1, "A": 2}]
    winners = {top3.tally(["A", "B", "C"], ballots, seed=s).winner for s in range(40)}
    assert winners == {"A", "B", "C"}
    r = top3.tally(["A", "B", "C"], ballots, seed=1)
    assert r.tiebreak == "random" and set(r.tie_group) == {"A", "B", "C"}


def test_a_two_title_night_is_pick_one() -> None:
    r = top3.tally(["A", "B"], [{"A": 1}, {"A": 1}, {"B": 1}], seed=3)
    assert r.ballot_size == 1 and order(r) == ["A", "B"] and r.placements[0].score == 2


def test_ties_below_the_winner_are_ordered_too() -> None:
    r = top3.tally(ABCD, [{"A": 1}], seed=11)
    assert order(r)[0] == "A" and sorted(order(r)[1:]) == ["B", "C", "D"]
    assert r.tiebreak == "none"


def test_to_json_is_the_stored_shape() -> None:
    r = top3.tally(["A", "B"], [{"B": 1}], seed=5)
    assert r.to_json() == {
        "method": "top3",
        "ballot_size": 1,
        "ballot_count": 1,
        "tie_group": ["B"],
        "tiebreak": "none",
        "placements": [
            {"option_id": "B", "place": 1, "score": 1, "first_places": 1},
            {"option_id": "A", "place": 2, "score": 0, "first_places": 0},
        ],
    }


def test_top3_is_the_registered_method() -> None:
    assert METHODS["top3"] is top3.tally


# --- Ballot validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("ranks", "message"),
    [
        ([], "between 1 and 3"),
        ([("A", 1), ("B", 2), ("C", 3), ("D", 4)], "between 1 and 3"),
        ([("A", 1), ("A", 2)], "only once"),
        ([("Z", 1)], "not on this shortlist"),
        ([("A", 2)], "without gaps"),
        ([("A", 1), ("B", 3)], "without gaps"),
        ([("A", 1), ("B", 1)], "without gaps"),
        ([("A", 0)], "without gaps"),
    ],
)
def test_bad_ballots_are_refused(ranks: list[tuple[str, int]], message: str) -> None:
    with pytest.raises(BallotError, match=message) as err:
        top3.check_ballot(ABCD, 3, ranks)
    assert message in err.value.reason


def test_a_partial_ballot_is_fine() -> None:
    assert top3.check_ballot(ABCD, 3, [("C", 1)]) == {"C": 1}
    assert top3.check_ballot(ABCD, 3, [("B", 2), ("C", 1)]) == {"C": 1, "B": 2}


def test_rank_three_is_refused_when_k_is_two() -> None:
    with pytest.raises(BallotError):
        top3.check_ballot(["A", "B", "C"], 2, [("A", 1), ("B", 2), ("C", 3)])


def test_tally_refuses_bad_input() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        top3.tally(["A", "A"], [], seed=0)
    with pytest.raises(ValueError, match="64 bits"):
        top3.tally(["A", "B"], [], seed=MAX_SEED + 1)
    with pytest.raises(ValueError, match="64 bits"):
        top3.tally(["A", "B"], [], seed=-1)
    with pytest.raises(SessionRuleError):
        top3.tally(["A"], [], seed=0)
    with pytest.raises(BallotError):
        top3.tally(["A", "B"], [{"A": 2}], seed=0)


# --- Properties ----------------------------------------------------------------------

seeds = st.integers(min_value=0, max_value=MAX_SEED)


@st.composite
def nights(draw: st.DrawFn) -> tuple[list[str], list[Ballot]]:
    """A shortlist of 2..8 and 0..12 valid (often partial) ballots."""
    n = draw(st.integers(min_value=2, max_value=8))
    options = [f"opt-{i}" for i in range(n)]
    k = min(3, n - 1)
    ballots: list[Ballot] = []
    for _ in range(draw(st.integers(min_value=0, max_value=12))):
        m = draw(st.integers(min_value=1, max_value=k))
        picked = draw(st.permutations(options))[:m]
        ballots.append({o: r for r, o in enumerate(picked, start=1)})
    return options, ballots


def _points(options: Sequence[str], ballots: Sequence[Ballot]) -> int:
    k = min(3, len(options) - 1)
    return sum(k - r + 1 for b in ballots for r in b.values())


@given(nights(), seeds)
def test_the_winner_is_always_a_shortlisted_option(
    night: tuple[list[str], list[Ballot]], seed: int
) -> None:
    options, ballots = night
    r = top3.tally(options, ballots, seed=seed)
    assert r.winner in options
    assert sorted(order(r)) == sorted(options)
    assert [p.place for p in r.placements] == list(range(1, len(options) + 1))
    assert r.winner in r.tie_group and set(r.tie_group) <= set(options)


@given(nights(), seeds, st.randoms(use_true_random=False))
def test_ballot_and_shortlist_order_do_not_matter(
    night: tuple[list[str], list[Ballot]], seed: int, rnd: random.Random
) -> None:
    options, ballots = night
    shuffled_ballots = list(ballots)
    rnd.shuffle(shuffled_ballots)
    shuffled_options = list(options)
    rnd.shuffle(shuffled_options)
    assert top3.tally(shuffled_options, shuffled_ballots, seed=seed) == top3.tally(
        options, ballots, seed=seed
    )


@given(nights(), seeds)
def test_the_same_seed_gives_the_same_ranking(
    night: tuple[list[str], list[Ballot]], seed: int
) -> None:
    options, ballots = night
    first = top3.tally(options, ballots, seed=seed)
    assert top3.tally(options, list(ballots), seed=seed) == first
    assert first.seed == seed


@given(nights(), seeds)
def test_partial_ballots_score_k_minus_r_plus_1(
    night: tuple[list[str], list[Ballot]], seed: int
) -> None:
    options, ballots = night
    r = top3.tally(options, ballots, seed=seed)
    assert sum(p.score for p in r.placements) == _points(options, ballots)
    assert sum(p.first_places for p in r.placements) == len(ballots)
    scores = [p.score for p in r.placements]
    assert scores == sorted(scores, reverse=True)
    assert all(p.score == r.placements[0].score for p in r.placements[: len(r.tie_group)])


@given(st.integers(min_value=2, max_value=8), seeds)
def test_zero_ballots_still_give_a_seeded_result(n: int, seed: int) -> None:
    options = [f"opt-{i}" for i in range(n)]
    r = top3.tally(options, [], seed=seed)
    assert r == top3.tally(list(reversed(options)), [], seed=seed)
    assert r.ballot_count == 0 and r.tiebreak == "random"
    assert set(r.tie_group) == set(options)
