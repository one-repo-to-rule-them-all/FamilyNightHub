# ADR-0010: Approval and pick-one voting: ballots, storage and a faithful tie-break

## Status

Accepted (2026-10-15). Extends [ADR-0006](ADR-0006-voting-rules-and-tie-break.md).

## Context

ADR-0006 fixed one pure tally interface, shipped `top3`, and promised `approval` and
`pick_one` for Phase 2. Its tie-break (first-place votes, then head-to-head, then a seeded
lottery) and its storage (`ballot_ranks`, rank 1..3, `unique(session, person, rank)`) are
written for ranked ballots of at most three entries. Approval ballots are unranked and can
hold the whole shortlist (up to 8). A pick-one ballot is a single choice. The rules for
both need to be stated, and three decisions have to be made: whether an empty approval
ballot counts, how each ADR-0006 tie-break step reads for these ballots, and how they are
stored.

## Decision

### The method is part of the draft

- A night's `voting_method` is set at creation (it defaults to the household's
  `settings.default_voting_method`) and can change only while the night is `draft`
  (`PATCH /sessions/{id}`; 409 afterwards). It locks with the shortlist when voting opens.
- The ballot size `k` (the most entries one ballot may hold) is fixed at open-voting per
  method: `top3` min(3, n - 1) (ADR-0006), `pick_one` 1, `approval` n.

### Ballots

- **pick_one**: exactly one shortlisted option at rank 1. One point per ballot.
- **approval**: 1..n distinct shortlisted options. One point per approval. Approving every
  option is allowed: it is an honest "any of these is fine". **An empty ballot is not
  allowed.** It would add no points, and "who has voted" (ADR-0006) is defined by a ballot
  having rows. Recording a voter who approves nothing would need a separate turnout table
  for a ballot that changes nothing. Someone with no preference can approve everything, or
  just not vote.
- The wire format is the same for every method: `ranks: [{option_id, rank}]`. For
  approval the ranks number the approvals 1..m with no gaps. That ordinal has **no
  meaning** in the tally; it exists so the rows satisfy `unique(session, person, rank)`.

### Tie-break, read faithfully

ADR-0006's three steps apply to every method. For these ballot types, steps 1 and 2 mean:

| Step (ADR-0006) | top3 | approval | pick_one |
|---|---|---|---|
| Score | Borda k-r+1 | approvals | votes |
| 1. First places | ballots ranking it 1st | **sole approvals**: ballots approving it and nothing else | = votes, so it never separates a score tie |
| 2. Head-to-head | ballots ranking A above B vs B above A | ballots approving A but not B vs B but not A, which is **always level** for a score tie | = votes, so it never separates a score tie |
| 3. Seeded lottery | ADR-0006 | same | same |

- **Approval, step 1.** A ranked ballot puts an option in first place when it prefers it
  strictly over every other option. The only way an approval ballot expresses that is by
  approving one option alone, so sole approvals are its first-place votes. They are stored
  in `placements[].first_places`.
- **Approval, step 2 is skipped.** For two options level on approvals,
  `approvals(A) - approvals(B) = #(A not B) - #(B not A) = 0`. Head-to-head can never
  separate them, so running it would be dead code. A Hypothesis property asserts this
  identity.
- **pick_one, steps 1 and 2 are skipped.** Every ballot is a first-place vote, and "ballots
  ranking A above B" is exactly A's vote count. Both reduce to the score, so a pick-one tie
  goes straight to the lottery.
- **The lottery is ADR-0006's.** One `random.Random(seed)` draw per option in sorted-id
  order. It depends only on the option set and the stored seed, never on ballot or
  shortlist order. The seed is still `secrets.randbits(64)`, stored on `sessions`, and
  pinned only by `X-FNH-Test-Seed` when ENVIRONMENT=test.
- `ranking.tiebreak` keeps ADR-0006's vocabulary. Approval reports `none`,
  `first_places` (sole approvals decided it) or `random`. Pick-one reports `none` or
  `random`. Neither reports `head_to_head`.

### Storage

- Ballots stay in `ballot_ranks`. Migration `0002_voting_methods_ranks` widens two checks
  from 1..3 to 1..8 (`MAX_OPTIONS`): `ck_ballot_ranks_rank` and `ck_sessions_ballot_size`.
  The unique constraints and the composite FK are unchanged. The tables already have forced
  RLS, and no new table is added.
- Trade-off: the database no longer enforces "rank <= 3" for top3 on its own. The per-method
  `check_ballot` in `domain/voting/` enforces it in the ballot service, and the tally
  re-checks every ballot it reads.

## Alternatives considered

**Approval stored as rank 1 for every approved option.** Rejected: it violates
`unique(session, person, rank)`. Dropping that constraint would also lose the top3
guarantee.

**A separate `ballot_approvals` table.** Rejected: a second RLS-scoped table, a second
"who has voted" source, a second read-back path and a history join, all to avoid a
meaningless ordinal.

**Head-to-head as approval's tie-break (as first sketched).** Rejected: it is provably
always level for a score tie (see above), so it would only add dead code.

**Fractional approval (each ballot splits one point across its approvals) as step 1.**
More informative than sole approvals, but it needs rational arithmetic and is harder to
explain on the TV. Sole approvals is the literal reading of "first place". It can be
revisited in a new ADR if real ties show the need.

**Allow empty approval ballots.** Rejected for the reasons above.

## Consequences

- `BallotIn` accepts up to 8 ranks of value 1..8. The per-method rules live in
  `domain/voting/{top3,approval,pick_one}.py` and are enforced by `ballot_service.cast`.
  Proxy ballots go through the same check.
- `close_voting` dispatches on `sessions.voting_method` via `domain.voting.METHODS`. The
  snapshot already exposes `voting_method`, so the TV labels scores per method (points,
  approvals, votes).
- `settings.default_voting_method` accepts all three methods.
- Tests: Hypothesis properties per method (the winner is shortlisted; ballot and shortlist
  order don't matter; the same seed gives the same ranking; approval's head-to-head
  identity; pick-one ties only by seed), plus integration tests per method and an E2E run
  of a pick-one night and an approval night with a pinned seed.
