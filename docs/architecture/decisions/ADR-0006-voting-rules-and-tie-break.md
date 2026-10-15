# ADR-0006: Top-3 ranked voting with adaptive ballot size, hidden tallies and a recorded tie-break

## Status

Proposed (2026-10-15)

## Context

Pick-one on a short list splits 2-1-1-1. Top-3 ranked (3/2/1 points) is the scope default, but it
breaks on shortlists of 3 or fewer, partial ballots were undefined, and live tallies on the TV
cause bandwagoning and tears. "Random pick among ties" must give every screen the **same** winner
and be reproducible in tests.

## Decision

- Tally methods implement one pure interface in `backend/app/domain/voting/`:
  `tally(options, ballots) -> Ranking` (ordered list with scores and tie groups). v1 ships `top3`;
  `approval` and `pick_one` follow in Phase 2.
- **Ballot size** `k = min(3, shortlist_size - 1)`. A shortlist of 2 is effectively pick-one; a
  shortlist of 1 needs no vote. Partial ballots are valid (rank 1 only is fine). Rank r is worth
  `k - r + 1` points.
- Enforced in the DB: `unique(session_id, person_id, rank)`, `unique(session_id, person_id, option_id)`,
  and rank between 1 and 3. Ballots are replaceable until close.
- **Tallies are hidden** until reveal. During voting, the TV shows who has voted (avatar tiles light
  up). Ballots are never readable by other devices.
- **Tie-break**, applied on close inside one transaction in `close_voting`: (1) most first-place
  votes; (2) head-to-head between the tied options; (3) random, seeded with `secrets.randbits(64)`.
  The seed, tie group and full ranking are stored on `sessions`. The spinner animation is
  cosmetic and replays the stored result.
- Close is idempotent (`status` check with `SELECT … FOR UPDATE`).

## Alternatives considered

**Live tallies (scope doc).** Rejected: social pressure on kids. Optional "show live" setting deferred.

**Pure random tie-break.** Rejected: ignores clear preference signals already in the ballots.

**Client-side random.** Rejected: screens could disagree, and results couldn't be reproduced.

## Consequences

- **Tests:** property-based tests (Hypothesis) for the tally: the winner is always a shortlisted
  option; ballot order doesn't change the result; the same seed gives the same winner; partial
  ballots are handled. The domain package has a 100% line-coverage gate, as in CAD.
- History stores the full ranking, so "correct a winner" in admin is a re-close with an audit row.
- See [`03-backend.md`](../03-backend.md) "Voting".
