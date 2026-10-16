"""The night's state machine and shortlist rules (03-backend.md "Voting", ADR-0006). Pure.

    draft -> voting -> revealed -> tonight -> closed

Only `draft` may edit the shortlist. Opening voting freezes it at 2..8 options and fixes
the ballot size k = min(3, n - 1). `revealed -> tonight` is lazy: `effective_status`
reports `tonight` once `revealed_at` is REVEAL_SETTLE old, and the next write persists it.
Services call these functions and persist the result; nothing here touches I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

Status = Literal["draft", "voting", "revealed", "tonight", "closed"]
Action = Literal["open_voting", "close_voting", "settle", "close"]

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


def ballot_size(option_count: int) -> int:
    """ADR-0006: k = min(3, n - 1). A shortlist of 2 is effectively pick-one."""
    if option_count < MIN_OPTIONS:
        raise SessionRuleError(f"A shortlist needs at least {MIN_OPTIONS} options")
    return min(MAX_BALLOT_SIZE, option_count - 1)


def open_voting(status: str, option_count: int) -> OpenedVoting:
    new_status = transition(status, "open_voting")
    if option_count > MAX_OPTIONS:
        raise SessionRuleError(f"A shortlist holds at most {MAX_OPTIONS} options")
    return OpenedVoting(new_status, ballot_size(option_count))


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


def effective_status(status: str, revealed_at: datetime | None, now: datetime) -> str:
    """What a reader should see: `revealed` turns into `tonight` after REVEAL_SETTLE."""
    if status == "revealed" and revealed_at is not None and now - revealed_at >= REVEAL_SETTLE:
        return "tonight"
    return status
