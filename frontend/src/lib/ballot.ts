/**
 * Tap-to-rank ballot state (04-frontend.md "Ballot", ADR-0006). Pure, so it is unit-tested to
 * 100% and the screen only renders it.
 *
 * - Tap an unranked poster: it takes the next rank (1, then 2, then 3), up to `size`
 *   (the night's ballot_size, k = min(3, options - 1)). A tap once full does nothing.
 * - Tap a ranked poster: it is cleared, and the posters below it move up a rank, so the ranks
 *   always run 1..m with no gaps (the server rejects gaps).
 * - Partial ballots are fine: "Done" is allowed from the first pick.
 */

export type BallotState = {
  /** Option ids in rank order: picks[0] is rank 1. */
  picks: string[];
  size: number;
};

export type BallotAction =
  | { type: "tap"; optionId: string }
  | { type: "clear" }
  /** Start from a saved ballot (GET /ballots/mine), e.g. to change your picks. */
  | { type: "load"; ranks: { option_id: string; rank: number }[] };

export function initialBallot(size: number): BallotState {
  return { picks: [], size: Math.max(0, size) };
}

export function ballotReducer(state: BallotState, action: BallotAction): BallotState {
  switch (action.type) {
    case "tap": {
      if (state.picks.includes(action.optionId)) {
        return { ...state, picks: state.picks.filter((id) => id !== action.optionId) };
      }
      if (state.picks.length >= state.size) return state;
      return { ...state, picks: [...state.picks, action.optionId] };
    }
    case "clear":
      return { ...state, picks: [] };
    case "load": {
      const picks = [...action.ranks]
        .sort((a, b) => a.rank - b.rank)
        .map((r) => r.option_id)
        .filter((id, index, all) => all.indexOf(id) === index)
        .slice(0, state.size);
      return { ...state, picks };
    }
  }
}

/** 1-based rank of an option, or null if it isn't picked. */
export function rankOf(state: BallotState, optionId: string): number | null {
  const index = state.picks.indexOf(optionId);
  return index === -1 ? null : index + 1;
}

export function canSubmit(state: BallotState): boolean {
  return state.picks.length > 0;
}

/** The PUT /ballots body's `ranks`. */
export function toRanks(state: BallotState): { option_id: string; rank: number }[] {
  return state.picks.map((option_id, index) => ({ option_id, rank: index + 1 }));
}
