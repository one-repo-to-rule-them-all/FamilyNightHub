"""Approval voting (ADR-0010, extending ADR-0006). Pure: no I/O.

A ballot approves 1..n options (k = n: approving every option is allowed; an empty
ballot is not, see ADR-0010). Each approval is one point. The ballot numbers its
approvals 1..m with no gaps; that ordinal only satisfies ballot_ranks' unique (session,
person, rank) and carries no preference.

Order: approvals, then ADR-0006's steps read for approval ballots:
(1) first places = sole approvals: the only way an approval ballot puts one option
strictly above every other is to approve it alone;
(2) head-to-head ("ballots approving A but not B") is skipped: for two options level on
approvals it is always level, since approvals(A) - approvals(B) = (A not B) - (B not A);
(3) ADR-0006's seeded lottery, one draw per option in sorted-id order.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.domain.session_state import ballot_size
from app.domain.voting.base import (
    Ballot,
    BallotError,
    Placement,
    Ranking,
    TieBreak,
    check_tally_input,
    seeded_lottery,
)

METHOD = "approval"


def check_ballot(
    options: Sequence[str], k: int, ranks: Sequence[tuple[str, int]]
) -> dict[str, int]:
    """Validate one ballot against the shortlist and k (= n); return option -> ordinal."""
    if not 1 <= len(ranks) <= k:
        raise BallotError(f"Approve between 1 and {k} options")
    ballot = dict(ranks)
    if len(ballot) != len(ranks):
        raise BallotError("Each option can be approved only once")
    if not set(ballot) <= set(options):
        raise BallotError("That option is not on this shortlist")
    if sorted(ballot.values()) != list(range(1, len(ballot) + 1)):
        raise BallotError("Number the approvals 1, 2, ... without gaps")
    return ballot


def tally(options: Sequence[str], ballots: Sequence[Ballot], *, seed: int) -> Ranking:
    check_tally_input(options, seed)
    k = ballot_size(len(options), METHOD)
    cast = [check_ballot(options, k, list(b.items())) for b in ballots]

    approvals = dict.fromkeys(options, 0)
    sole = dict.fromkeys(options, 0)
    for ballot in cast:
        for option in ballot:
            approvals[option] += 1
            sole[option] += len(ballot) == 1

    lottery = seeded_lottery(options, seed)
    ordered = sorted(options, key=lambda o: (-approvals[o], -sole[o], lottery[o]))
    winner = ordered[0]
    tie_group = tuple(o for o in ordered if approvals[o] == approvals[winner])
    return Ranking(
        method=METHOD,
        ballot_size=k,
        ballot_count=len(cast),
        seed=seed,
        # `first_places` holds sole approvals, the approval reading of a first place.
        placements=tuple(
            Placement(o, place, approvals[o], sole[o]) for place, o in enumerate(ordered, start=1)
        ),
        tie_group=tie_group,
        tiebreak=_decided_by(winner, tie_group, sole),
    )


def _decided_by(winner: str, tie_group: tuple[str, ...], sole: dict[str, int]) -> TieBreak:
    rivals = [o for o in tie_group if o != winner]
    if not rivals:
        return "none"
    if all(sole[o] < sole[winner] for o in rivals):
        return "first_places"
    return "random"
