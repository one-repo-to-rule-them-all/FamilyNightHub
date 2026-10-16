"""Approval and pick-one tallies and their tie-breaks (ADR-0010): examples plus Hypothesis."""

from __future__ import annotations

import random
from collections.abc import Callable

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.session_state import SessionRuleError
from app.domain.voting import BALLOT_CHECKS, METHODS, approval, pick_one, top3
from app.domain.voting.base import MAX_SEED, Ballot, BallotError, Ranking

ABCD = ["A", "B", "C", "D"]
Night = tuple[list[str], list[Ballot]]


def order(ranking: Ranking) -> list[str]:
    return [p.option_id for p in ranking.placements]


def test_every_method_is_registered() -> None:
    assert METHODS == {"top3": top3.tally, "approval": approval.tally, "pick_one": pick_one.tally}
    assert BALLOT_CHECKS == {
        "top3": top3.check_ballot,
        "approval": approval.check_ballot,
        "pick_one": pick_one.check_ballot,
    }


# --- pick_one --------------------------------------------------------------------------


def test_pick_one_counts_one_point_per_ballot() -> None:
    r = pick_one.tally(ABCD, [{"B": 1}, {"B": 1}, {"A": 1}], seed=7)
    assert (r.method, r.ballot_size, r.ballot_count) == ("pick_one", 1, 3)
    assert [(p.option_id, p.score, p.first_places) for p in r.placements[:2]] == [
        ("B", 2, 2),
        ("A", 1, 1),
    ]
    assert (r.winner, r.tie_group, r.tiebreak) == ("B", ("B",), "none")


def test_a_pick_one_tie_goes_straight_to_the_seeded_lottery() -> None:
    ballots = [{"A": 1}, {"B": 1}, {"C": 1}, {"A": 1}, {"B": 1}]
    winners = {pick_one.tally(ABCD, ballots, seed=s).winner for s in range(40)}
    assert winners == {"A", "B"}
    r = pick_one.tally(ABCD, ballots, seed=1)
    assert r.tiebreak == "random" and set(r.tie_group) == {"A", "B"}
    assert order(r)[2:] == ["C", "D"]


@pytest.mark.parametrize(
    ("ranks", "message"),
    [
        ([], "exactly one"),
        ([("A", 1), ("B", 2)], "exactly one"),
        ([("Z", 1)], "not on this shortlist"),
        ([("A", 2)], "rank 1 only"),
    ],
)
def test_bad_pick_one_ballots_are_refused(ranks: list[tuple[str, int]], message: str) -> None:
    with pytest.raises(BallotError, match=message):
        pick_one.check_ballot(ABCD, 1, ranks)


def test_pick_one_tally_refuses_bad_input() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        pick_one.tally(["A", "A"], [], seed=0)
    with pytest.raises(ValueError, match="64 bits"):
        pick_one.tally(["A", "B"], [], seed=MAX_SEED + 1)
    with pytest.raises(SessionRuleError):
        pick_one.tally(["A"], [], seed=0)
    with pytest.raises(BallotError):
        pick_one.tally(["A", "B"], [{"A": 1, "B": 2}], seed=0)


# --- approval --------------------------------------------------------------------------


def test_approval_counts_one_point_per_approval() -> None:
    ballots = [{"A": 1, "B": 2}, {"A": 1, "C": 2, "D": 3}, {"B": 1}]
    r = approval.tally(ABCD, ballots, seed=7)
    assert (r.method, r.ballot_size, r.ballot_count) == ("approval", 4, 3)
    # A: 2 approvals, none alone; B: 2 approvals, one alone -> B wins on sole approvals.
    assert [(p.option_id, p.score, p.first_places) for p in r.placements[:2]] == [
        ("B", 2, 1),
        ("A", 2, 0),
    ]
    assert (r.winner, r.tie_group, r.tiebreak) == ("B", ("B", "A"), "first_places")


def test_approval_with_no_tie() -> None:
    r = approval.tally(ABCD, [{"C": 1, "D": 2}, {"C": 1}], seed=3)
    assert (r.winner, r.tie_group, r.tiebreak) == ("C", ("C",), "none")


def test_approving_everything_is_allowed_and_counts() -> None:
    r = approval.tally(["A", "B"], [{"A": 1, "B": 2}, {"B": 1}], seed=0)
    assert [(p.option_id, p.score, p.first_places) for p in r.placements] == [
        ("B", 2, 1),
        ("A", 1, 0),
    ]


def test_an_approval_tie_level_on_sole_approvals_falls_to_the_lottery() -> None:
    # A and B: two approvals each, one sole approval each.
    ballots = [{"A": 1}, {"B": 1}, {"A": 1, "B": 2}]
    winners = {approval.tally(ABCD, ballots, seed=s).winner for s in range(40)}
    assert winners == {"A", "B"}
    r = approval.tally(ABCD, ballots, seed=2)
    assert r.tiebreak == "random" and set(r.tie_group) == {"A", "B"}


@pytest.mark.parametrize(
    ("ranks", "message"),
    [
        ([], "between 1 and 4"),
        ([("A", 1), ("B", 2), ("C", 3), ("D", 4), ("A", 5)], "between 1 and 4"),
        ([("A", 1), ("A", 2)], "only once"),
        ([("Z", 1)], "not on this shortlist"),
        ([("A", 1), ("B", 3)], "without gaps"),
        ([("A", 1), ("B", 1)], "without gaps"),
    ],
)
def test_bad_approval_ballots_are_refused(ranks: list[tuple[str, int]], message: str) -> None:
    with pytest.raises(BallotError, match=message):
        approval.check_ballot(ABCD, 4, ranks)


def test_approval_tally_refuses_bad_input() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        approval.tally(["A", "A"], [], seed=0)
    with pytest.raises(ValueError, match="64 bits"):
        approval.tally(["A", "B"], [], seed=-1)
    with pytest.raises(SessionRuleError):
        approval.tally(["A"], [], seed=0)
    with pytest.raises(BallotError):
        approval.tally(["A", "B"], [{"A": 2}], seed=0)


# --- Properties ------------------------------------------------------------------------

seeds = st.integers(min_value=0, max_value=MAX_SEED)


@st.composite
def approval_nights(draw: st.DrawFn) -> Night:
    """A shortlist of 2..8 and 0..12 approval ballots of 1..n approvals each."""
    n = draw(st.integers(min_value=2, max_value=8))
    options = [f"opt-{i}" for i in range(n)]
    ballots: list[Ballot] = []
    for _ in range(draw(st.integers(min_value=0, max_value=12))):
        picked = draw(st.permutations(options))[: draw(st.integers(min_value=1, max_value=n))]
        ballots.append({o: r for r, o in enumerate(picked, start=1)})
    return options, ballots


@st.composite
def pick_one_nights(draw: st.DrawFn) -> Night:
    n = draw(st.integers(min_value=2, max_value=8))
    options = [f"opt-{i}" for i in range(n)]
    picks = draw(st.lists(st.sampled_from(options), max_size=12))
    return options, [{o: 1} for o in picks]


CASES: list[tuple[Callable[..., Ranking], st.SearchStrategy[Night]]] = [
    (approval.tally, approval_nights()),
    (pick_one.tally, pick_one_nights()),
]


@pytest.mark.parametrize(("tally", "nights"), CASES, ids=["approval", "pick_one"])
@given(data=st.data(), seed=seeds)
def test_the_winner_is_always_a_shortlisted_option(
    tally: Callable[..., Ranking], nights: st.SearchStrategy[Night], data: st.DataObject, seed: int
) -> None:
    options, ballots = data.draw(nights)
    r = tally(options, ballots, seed=seed)
    assert r.winner in options and r.winner in r.tie_group
    assert sorted(order(r)) == sorted(options)
    assert [p.place for p in r.placements] == list(range(1, len(options) + 1))
    scores = [p.score for p in r.placements]
    assert scores == sorted(scores, reverse=True)
    assert sum(scores) == sum(len(b) for b in ballots)


@pytest.mark.parametrize(("tally", "nights"), CASES, ids=["approval", "pick_one"])
@given(data=st.data(), seed=seeds, rnd=st.randoms(use_true_random=False))
def test_ballot_and_shortlist_order_do_not_matter(
    tally: Callable[..., Ranking],
    nights: st.SearchStrategy[Night],
    data: st.DataObject,
    seed: int,
    rnd: random.Random,
) -> None:
    options, ballots = data.draw(nights)
    shuffled_ballots, shuffled_options = list(ballots), list(options)
    rnd.shuffle(shuffled_ballots)
    rnd.shuffle(shuffled_options)
    assert tally(shuffled_options, shuffled_ballots, seed=seed) == tally(
        options, ballots, seed=seed
    )


@pytest.mark.parametrize(("tally", "nights"), CASES, ids=["approval", "pick_one"])
@given(data=st.data(), seed=seeds)
def test_the_same_seed_gives_the_same_ranking(
    tally: Callable[..., Ranking], nights: st.SearchStrategy[Night], data: st.DataObject, seed: int
) -> None:
    options, ballots = data.draw(nights)
    first = tally(options, ballots, seed=seed)
    assert tally(list(options), list(ballots), seed=seed) == first and first.seed == seed


@given(approval_nights())
def test_head_to_head_can_never_split_an_approval_tie(night: Night) -> None:
    """Why ADR-0010 skips ADR-0006 step 2: options level on approvals are level pairwise."""
    options, ballots = night
    approvals = {o: sum(o in b for b in ballots) for o in options}
    for a in options:
        for b in options:
            if approvals[a] == approvals[b]:
                a_not_b = sum(a in bl and b not in bl for bl in ballots)
                b_not_a = sum(b in bl and a not in bl for bl in ballots)
                assert a_not_b == b_not_a


@given(approval_nights(), seeds)
def test_approval_breaks_ties_on_sole_approvals_then_seed(night: Night, seed: int) -> None:
    options, ballots = night
    r = approval.tally(options, ballots, seed=seed)
    assert r.tiebreak != "head_to_head"
    sole = {p.option_id: p.first_places for p in r.placements}
    assert sole == {o: sum(b.keys() == {o} for b in ballots) for o in options}
    assert sole[r.winner] == max(sole[o] for o in r.tie_group)
    if r.tiebreak == "first_places":
        assert all(sole[o] < sole[r.winner] for o in r.tie_group if o != r.winner)


@given(pick_one_nights(), seeds)
def test_pick_one_ties_are_decided_only_by_the_seed(night: Night, seed: int) -> None:
    options, ballots = night
    r = pick_one.tally(options, ballots, seed=seed)
    assert r.tiebreak == ("none" if len(r.tie_group) == 1 else "random")
    assert all(p.first_places == p.score for p in r.placements)
