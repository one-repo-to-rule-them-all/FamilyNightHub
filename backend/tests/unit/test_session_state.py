from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain import session_state as ss
from app.domain.session_state import SessionRuleError

STATUSES = ["draft", "voting", "revealed", "tonight", "closed"]
NOW = datetime(2026, 10, 15, 20, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("status", "action", "expected"),
    [
        ("draft", "open_voting", "voting"),
        ("voting", "close_voting", "revealed"),
        ("revealed", "settle", "tonight"),
        ("tonight", "close", "closed"),
    ],
)
def test_the_happy_path(status: str, action: ss.Action, expected: str) -> None:
    assert ss.transition(status, action) == expected


@pytest.mark.parametrize("status", STATUSES)
@pytest.mark.parametrize("action", ["open_voting", "close_voting", "settle", "close"])
def test_every_other_transition_is_refused(status: str, action: ss.Action) -> None:
    if (status, action) in ss.TRANSITIONS:
        return
    with pytest.raises(SessionRuleError) as err:
        ss.transition(status, action)
    assert status in err.value.reason


def test_closed_is_terminal() -> None:
    assert not [k for k in ss.TRANSITIONS if k[0] == "closed"]


@pytest.mark.parametrize(("n", "k"), [(2, 1), (3, 2), (4, 3), (5, 3), (8, 3)])
def test_ballot_size_is_min_3_n_minus_1(n: int, k: int) -> None:
    assert ss.ballot_size(n) == k


@pytest.mark.parametrize("n", [0, 1])
def test_ballot_size_needs_two_options(n: int) -> None:
    with pytest.raises(SessionRuleError):
        ss.ballot_size(n)


@given(st.integers(min_value=2, max_value=8))
def test_open_voting_with_a_valid_shortlist(n: int) -> None:
    opened = ss.open_voting("draft", n)
    assert opened.status == "voting"
    assert 1 <= opened.ballot_size <= 3
    assert opened.ballot_size < n


@pytest.mark.parametrize("n", [0, 1, 9, 12])
def test_open_voting_rejects_bad_shortlist_sizes(n: int) -> None:
    with pytest.raises(SessionRuleError):
        ss.open_voting("draft", n)


@pytest.mark.parametrize("status", ["voting", "revealed", "tonight", "closed"])
def test_open_voting_only_from_draft(status: str) -> None:
    with pytest.raises(SessionRuleError):
        ss.open_voting(status, 3)


def test_shortlist_is_editable_only_in_draft() -> None:
    ss.check_shortlist_editable("draft")
    for status in STATUSES[1:]:
        with pytest.raises(SessionRuleError):
            ss.check_shortlist_editable(status)


def test_add_option_up_to_eight() -> None:
    for n in range(ss.MAX_OPTIONS):
        ss.check_can_add_option("draft", n)
    with pytest.raises(SessionRuleError):
        ss.check_can_add_option("draft", ss.MAX_OPTIONS)
    with pytest.raises(SessionRuleError):
        ss.check_can_add_option("voting", 2)


def test_rotate_code_until_closed() -> None:
    for status in STATUSES[:-1]:
        ss.check_can_rotate_code(status)
    with pytest.raises(SessionRuleError):
        ss.check_can_rotate_code("closed")


@pytest.mark.parametrize(
    ("current", "requested", "ok"),
    [
        (["a", "b", "c"], ["c", "a", "b"], True),
        (["a", "b"], ["a", "b"], True),
        (["a", "b", "c"], ["a", "b"], False),  # missing one
        (["a", "b"], ["a", "b", "x"], False),  # foreign id
        (["a", "b"], ["a", "a", "b"], False),  # duplicate
        (["a", "b"], ["a", "a"], False),
    ],
)
def test_reorder_must_be_a_permutation(current: list[str], requested: list[str], ok: bool) -> None:
    if ok:
        ss.check_reorder(current, requested)
    else:
        with pytest.raises(SessionRuleError):
            ss.check_reorder(current, requested)


def test_revealed_settles_into_tonight_after_30s() -> None:
    assert ss.effective_status("revealed", NOW - timedelta(seconds=29), NOW) == "revealed"
    assert ss.effective_status("revealed", NOW - timedelta(seconds=30), NOW) == "tonight"
    assert ss.effective_status("revealed", None, NOW) == "revealed"


@pytest.mark.parametrize("status", ["draft", "voting", "tonight", "closed"])
def test_effective_status_leaves_other_statuses_alone(status: str) -> None:
    assert ss.effective_status(status, NOW - timedelta(days=1), NOW) == status
