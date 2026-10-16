"""Top-3 ranked voting with an adaptive ballot size (ADR-0006). Pure: no I/O.

Ballot size k = min(3, n - 1) for a shortlist of n. A ballot ranks 1..m options with
1 <= m <= k and no gaps (rank 1 only is fine); rank r is worth k - r + 1 points.

Order: points, then (1) most first-place votes, (2) head-to-head among the options still
level: each scores one win per other member that more ballots rank above it than below
(an unranked option counts as below every ranked one), (3) a seeded lottery. The lottery
draws one number per option in sorted-id order from `random.Random(seed)`, so it depends
only on the option set and the seed, never on ballot or shortlist order.
"""

from __future__ import annotations

import random
from collections.abc import Sequence

from app.domain.session_state import ballot_size
from app.domain.voting.base import (
    MAX_SEED,
    Ballot,
    BallotError,
    Placement,
    Ranking,
    TieBreak,
)

METHOD = "top3"


def check_ballot(
    options: Sequence[str], k: int, ranks: Sequence[tuple[str, int]]
) -> dict[str, int]:
    """Validate one ballot against the shortlist and k; return it as option -> rank."""
    if not 1 <= len(ranks) <= k:
        raise BallotError(f"Rank between 1 and {k} options")
    ballot = dict(ranks)
    if len(ballot) != len(ranks):
        raise BallotError("Each option can be ranked only once")
    if not set(ballot) <= set(options):
        raise BallotError("That option is not on this shortlist")
    if sorted(ballot.values()) != list(range(1, len(ballot) + 1)):
        raise BallotError(f"Ranks must run 1, 2, ... without gaps (at most {k})")
    return ballot


def tally(options: Sequence[str], ballots: Sequence[Ballot], *, seed: int) -> Ranking:
    if len(set(options)) != len(options):
        raise ValueError("duplicate option ids")
    if not 0 <= seed <= MAX_SEED:
        raise ValueError("seed must fit in 64 bits")
    k = ballot_size(len(options))
    cast = [check_ballot(options, k, list(b.items())) for b in ballots]

    score = dict.fromkeys(options, 0)
    firsts = dict.fromkeys(options, 0)
    for ballot in cast:
        for option, rank in ballot.items():
            score[option] += k - rank + 1
            firsts[option] += rank == 1

    rng = random.Random(seed)
    lottery = {option: rng.random() for option in sorted(options)}

    def prefers(a: str, b: str) -> int:
        """Ballots ranking a above b."""
        return sum(1 for bl in cast if a in bl and (b not in bl or bl[a] < bl[b]))

    def h2h_wins(option: str, group: list[str]) -> int:
        return sum(
            1
            for other in group
            if other != option and prefers(option, other) > prefers(other, option)
        )

    # Group by (points, first places); order each group by head-to-head, then lottery.
    blocks: dict[tuple[int, int], list[str]] = {}
    for option in options:
        blocks.setdefault((score[option], firsts[option]), []).append(option)
    wins: dict[str, int] = {}
    ordered: list[str] = []
    for key in sorted(blocks, reverse=True):
        block = blocks[key]
        wins.update({o: h2h_wins(o, block) for o in block})
        ordered += sorted(block, key=lambda o: (-wins[o], lottery[o]))

    winner = ordered[0]
    tie_group = tuple(o for o in ordered if score[o] == score[winner])
    return Ranking(
        method=METHOD,
        ballot_size=k,
        ballot_count=len(cast),
        seed=seed,
        placements=tuple(
            Placement(o, place, score[o], firsts[o]) for place, o in enumerate(ordered, start=1)
        ),
        tie_group=tie_group,
        tiebreak=_decided_by(winner, tie_group, firsts, wins),
    )


def _decided_by(
    winner: str, tie_group: tuple[str, ...], firsts: dict[str, int], wins: dict[str, int]
) -> TieBreak:
    rivals = [o for o in tie_group if o != winner]
    if not rivals:
        return "none"
    level = [o for o in rivals if firsts[o] == firsts[winner]]
    if not level:
        return "first_places"
    if all(wins[o] < wins[winner] for o in level):
        return "head_to_head"
    return "random"
