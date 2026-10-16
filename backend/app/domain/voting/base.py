"""The tally interface every voting method implements (ADR-0006). Pure: no I/O.

A method takes the shortlist's option ids, the cast ballots and a seed, and returns a
fully ordered `Ranking`. The seed is the only source of randomness: the same inputs and
seed always give the same ranking, which is what lets every screen agree on the winner
and lets tests reproduce a tie-break. Production draws it with `secrets.randbits(64)`.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

MAX_SEED = 2**64 - 1  # sessions.tie_seed is numeric(20)

Ballot = Mapping[str, int]
"""One person's ballot: option id -> rank (1 = favourite). Partial ballots are fine.
pick_one holds one entry at rank 1; approval numbers its approvals 1..m, an ordinal that
carries no preference (ADR-0010)."""

TieBreak = Literal["none", "first_places", "head_to_head", "random"]
"""Which step separated the winner from the options tied with it on score."""


class BallotError(ValueError):
    """A ballot that breaks the method's rules. `reason` is safe to show the voter."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Placement:
    option_id: str
    place: int  # 1-based position in the final order (after tie-breaks)
    score: int
    first_places: int


@dataclass(frozen=True)
class Ranking:
    method: str
    ballot_size: int
    ballot_count: int
    seed: int
    placements: tuple[Placement, ...]
    # Options level with the winner on score before any tie-break (just the winner if none).
    tie_group: tuple[str, ...]
    tiebreak: TieBreak

    @property
    def winner(self) -> str:
        return self.placements[0].option_id

    def to_json(self) -> dict[str, Any]:
        """The shape stored in sessions.ranking (the seed has its own column)."""
        return {
            "method": self.method,
            "ballot_size": self.ballot_size,
            "ballot_count": self.ballot_count,
            "tie_group": list(self.tie_group),
            "tiebreak": self.tiebreak,
            "placements": [
                {
                    "option_id": p.option_id,
                    "place": p.place,
                    "score": p.score,
                    "first_places": p.first_places,
                }
                for p in self.placements
            ],
        }


class TallyMethod(Protocol):
    def __call__(
        self, options: Sequence[str], ballots: Sequence[Ballot], *, seed: int
    ) -> Ranking: ...


class BallotCheck(Protocol):
    """Validate one ballot against the shortlist and k; return it as option -> rank."""

    def __call__(
        self, options: Sequence[str], k: int, ranks: Sequence[tuple[str, int]]
    ) -> dict[str, int]: ...


def check_tally_input(options: Sequence[str], seed: int) -> None:
    if len(set(options)) != len(options):
        raise ValueError("duplicate option ids")
    if not 0 <= seed <= MAX_SEED:
        raise ValueError("seed must fit in 64 bits")


def seeded_lottery(options: Sequence[str], seed: int) -> dict[str, float]:
    """One draw per option in sorted-id order, so the result depends only on the option
    set and the seed, never on ballot or shortlist order (ADR-0006 step 3)."""
    rng = random.Random(seed)
    return {option: rng.random() for option in sorted(options)}
