"""Pick-one voting (ADR-0010, extending ADR-0006). Pure: no I/O.

A ballot holds exactly one option at rank 1; each ballot is one point. Ballot size k = 1.

Order: votes, then the seeded lottery. ADR-0006's first two tie-break steps cannot
separate options level on votes here: every ballot is a first-place vote (so first places
equal votes), and "ballots ranking A above B" is exactly A's vote count (so head-to-head
between two options tied on votes is always level). They are skipped, not run as no-ops.
The lottery is ADR-0006's: one draw per option in sorted-id order from
`random.Random(seed)`.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.domain.session_state import ballot_size
from app.domain.voting.base import (
    Ballot,
    BallotError,
    Placement,
    Ranking,
    check_tally_input,
    seeded_lottery,
)

METHOD = "pick_one"


def check_ballot(
    options: Sequence[str], k: int, ranks: Sequence[tuple[str, int]]
) -> dict[str, int]:
    """Validate one ballot: exactly one shortlisted option, at rank 1. `k` is always 1."""
    if len(ranks) != 1:
        raise BallotError("Pick exactly one option")
    ((option, rank),) = ranks
    if option not in options:
        raise BallotError("That option is not on this shortlist")
    if rank != 1:
        raise BallotError("A pick-one ballot has rank 1 only")
    return {option: 1}


def tally(options: Sequence[str], ballots: Sequence[Ballot], *, seed: int) -> Ranking:
    check_tally_input(options, seed)
    k = ballot_size(len(options), METHOD)
    cast = [check_ballot(options, k, list(b.items())) for b in ballots]

    votes = dict.fromkeys(options, 0)
    for ballot in cast:
        for option in ballot:
            votes[option] += 1

    lottery = seeded_lottery(options, seed)
    ordered = sorted(options, key=lambda o: (-votes[o], lottery[o]))
    winner = ordered[0]
    tie_group = tuple(o for o in ordered if votes[o] == votes[winner])
    return Ranking(
        method=METHOD,
        ballot_size=k,
        ballot_count=len(cast),
        seed=seed,
        # Every vote is a first-place vote.
        placements=tuple(
            Placement(o, place, votes[o], votes[o]) for place, o in enumerate(ordered, start=1)
        ),
        tie_group=tie_group,
        tiebreak="none" if len(tie_group) == 1 else "random",
    )
