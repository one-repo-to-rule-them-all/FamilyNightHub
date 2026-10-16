"""The night's state machine and shortlist rules (03-backend.md "Voting", ADR-0006). Pure.

    draft -> voting -> revealed -> tonight -> closed

Only `draft` may edit the shortlist or change the voting method. Opening voting freezes
the shortlist at 2..8 options and fixes the ballot size k for the night's method: top3
min(3, n - 1), pick_one 1, approval n (ADR-0006, ADR-0010). `revealed -> tonight` is
lazy: `effective_status` reports `tonight` once `revealed_at` is REVEAL_SETTLE old, and
the next write persists it.
Services call these functions and persist the result; nothing here touches I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

Status = Literal["draft", "voting", "revealed", "tonight", "closed"]
Action = Literal["open_voting", "close_voting", "settle", "close"]
VotingMethod = Literal["top3", "approval", "pick_one"]
VOTING_METHODS: tuple[VotingMethod, ...] = ("top3", "approval", "pick_one")

MIN_OPTIONS = 2
MAX_OPTIONS = 8
MAX_BALLOT_SIZE = 3
REVEAL_SETTLE = timedelta(seconds=30)

TRANSITIONS: dict[tuple[str, Action], Status] = {
    ("draft", "open_voting"): "voting",
    ("voting", "close_voting"): "revealed",
    ("revealed", "settle"): "tonight",
    ("tonight", "close"): "closed",
}


class SessionRuleError(Exception):
    """A rule of the night was broken. `reason` is safe to show the host."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class OpenedVoting:
    status: Status
    ballot_size: int


def transition(status: str, action: Action) -> Status:
    """The status after `action`, or SessionRuleError if it isn't allowed from `status`."""
    try:
        return TRANSITIONS[(status, action)]
    except KeyError:
        raise SessionRuleError(f"Cannot {action.replace('_', ' ')} while {status}") from None


def ballot_size(option_count: int, method: str = "top3") -> int:
    """The most entries one ballot may hold. top3 (ADR-0006): k = min(3, n - 1), so a
    shortlist of 2 is effectively pick-one. pick_one: 1. approval: n (ADR-0010)."""
    if option_count < MIN_OPTIONS:
        raise SessionRuleError(f"A shortlist needs at least {MIN_OPTIONS} options")
    if method == "top3":
        return min(MAX_BALLOT_SIZE, option_count - 1)
    if method == "pick_one":
        return 1
    if method == "approval":
        return option_count
    raise ValueError(f"unknown voting method {method!r}")


def open_voting(status: str, option_count: int, method: str = "top3") -> OpenedVoting:
    new_status = transition(status, "open_voting")
    if option_count > MAX_OPTIONS:
        raise SessionRuleError(f"A shortlist holds at most {MAX_OPTIONS} options")
    return OpenedVoting(new_status, ballot_size(option_count, method))


def check_can_change_method(status: str) -> None:
    """The voting method is part of the draft: it locks with the shortlist (ADR-0010)."""
    if status != "draft":
        raise SessionRuleError("The voting method is locked once voting opens")


def check_shortlist_editable(status: str) -> None:
    if status != "draft":
        raise SessionRuleError("The shortlist is locked once voting opens")


def check_can_add_option(status: str, option_count: int) -> None:
    check_shortlist_editable(status)
    if option_count >= MAX_OPTIONS:
        raise SessionRuleError(f"A shortlist holds at most {MAX_OPTIONS} options")


def check_can_rotate_code(status: str) -> None:
    """A closed night has released its code; there is nothing left to rotate."""
    if status == "closed":
        raise SessionRuleError("This night is closed")


def check_reorder(current: list[str], requested: list[str]) -> None:
    """A reorder must name every current option exactly once."""
    if len(requested) != len(set(requested)) or set(requested) != set(current):
        raise SessionRuleError("Reorder must list every option in this shortlist exactly once")


PHOTO_STATUSES: frozenset[str] = frozenset({"tonight", "closed"})


def check_photos_open(effective: str) -> None:
    """ADR-0005: the album opens once the movie is picked (`tonight`) and stays open after
    the night closes. Pass the *effective* status, so a settled reveal counts as tonight."""
    if effective not in PHOTO_STATUSES:
        raise SessionRuleError("Photos open once tonight's movie is picked")


RATING_STATUSES: frozenset[str] = frozenset({"tonight", "closed"})


def check_can_rate(effective: str) -> None:
    """Ratings open with the movie (`tonight`) and stay open once the night closes; the
    phone asks after the movie, but a rating given early is kept. Pass the *effective*
    status, so a settled reveal counts as tonight."""
    if effective not in RATING_STATUSES:
        raise SessionRuleError("Ratings open once tonight's movie is picked")


def shows_rating(effective: str) -> bool:
    """The family average is shown only once ratings are open (never mid-vote)."""
    return effective in RATING_STATUSES


def effective_status(status: str, revealed_at: datetime | None, now: datetime) -> str:
    """What a reader should see: `revealed` turns into `tonight` after REVEAL_SETTLE."""
    if status == "revealed" and revealed_at is not None and now - revealed_at >= REVEAL_SETTLE:
        return "tonight"
    return status


def settle(status: str, revealed_at: datetime | None, now: datetime) -> Status | None:
    """The status the next write must persist when readers already see `tonight`, else None."""
    if effective_status(status, revealed_at, now) != status:
        return transition(status, "settle")
    return None


RESULT_STATUSES = frozenset({"revealed", "tonight", "closed"})


def shows_result(status: str) -> bool:
    """Ranking and winner stay hidden until reveal (ADR-0006)."""
    return status in RESULT_STATUSES


def check_can_correct_winner(status: str) -> None:
    """An admin may correct the winner only once there is one (ADR-0006: a re-close with
    an audit row). A draft or a night still voting has no winner to correct."""
    if status not in RESULT_STATUSES:
        raise SessionRuleError("Only a night that has picked its movie can be corrected")


def check_can_vote(status: str) -> None:
    """Ballots are cast and replaced only while voting is open."""
    if status != "voting":
        raise SessionRuleError("Voting is not open")


def close_voting(status: str) -> Status | None:
    """voting -> revealed. None if voting already closed: a repeat close is a no-op."""
    if status in RESULT_STATUSES:
        return None
    return transition(status, "close_voting")


def close_night(status: str) -> Status | None:
    """tonight -> closed. None if already closed."""
    if status == "closed":
        return None
    return transition(status, "close")
