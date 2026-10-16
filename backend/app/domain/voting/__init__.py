"""Voting methods (ADR-0006, ADR-0010). Each has a pure `tally(options, ballots, *, seed)
-> Ranking` and a `check_ballot(options, k, ranks)`. v1 shipped `top3`; `approval` and
`pick_one` came in Phase 2.
"""

from __future__ import annotations

from app.domain.voting import approval, pick_one, top3
from app.domain.voting.base import BallotCheck, TallyMethod

METHODS: dict[str, TallyMethod] = {
    top3.METHOD: top3.tally,
    approval.METHOD: approval.tally,
    pick_one.METHOD: pick_one.tally,
}

BALLOT_CHECKS: dict[str, BallotCheck] = {
    top3.METHOD: top3.check_ballot,
    approval.METHOD: approval.check_ballot,
    pick_one.METHOD: pick_one.check_ballot,
}
