"""Voting methods (ADR-0006): one pure `tally(options, ballots, *, seed) -> Ranking` each.

v1 ships `top3`; `approval` and `pick_one` follow in Phase 2.
"""

from __future__ import annotations

from app.domain.voting import top3
from app.domain.voting.base import TallyMethod

METHODS: dict[str, TallyMethod] = {top3.METHOD: top3.tally}
