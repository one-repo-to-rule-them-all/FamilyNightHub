/**
 * Ballot state for every voting method (04-frontend.md "Ballot", ADR-0006, ADR-0010). Pure, so it
 * is unit-tested to 100% and the screens only render it.
 *
 * - top3, tap-to-rank: tap an unranked poster and it takes the next rank (1, then 2, then 3), up
 *   to `size` (the night's ballot_size, k = min(3, options - 1)). A tap once full does nothing.
 *   Tap a ranked poster and it is cleared; the posters below it move up a rank, so the ranks
 *   always run 1..m with no gaps (the server rejects gaps).
 * - pick_one, tap one: a tap picks that poster and drops any earlier pick; tapping the picked
 *   poster clears it.
 * - approval, tap to toggle: tap any number of posters on or off (size = the whole shortlist).
 *   The picks are sent numbered 1..m, an order the server ignores.
 * - Every method needs at least one pick before "Done" (an empty ballot is refused, ADR-0010).
 */

import type { VotingMethod } from "@/lib/api";

export type BallotState = {
  method: VotingMethod;
  /** Option ids in pick order: for top3, picks[0] is rank 1. */
  picks: string[];
  size: number;
};

export type BallotAction =
  | { type: "tap"; optionId: string }
  | { type: "clear" }
  /** Start from a saved ballot (GET /ballots/mine), e.g. to change your picks. */
  | { type: "load"; ranks: { option_id: string; rank: number }[] };

export function initialBallot(size: number, method: VotingMethod = "top3"): BallotState {
  return { method, picks: [], size: Math.max(0, size) };
}

export function ballotReducer(state: BallotState, action: BallotAction): BallotState {
  switch (action.type) {
    case "tap": {
      if (state.picks.includes(action.optionId)) {
        return { ...state, picks: state.picks.filter((id) => id !== action.optionId) };
      }
      if (state.picks.length >= state.size) {
        if (state.method === "pick_one" && state.size > 0) {
          return { ...state, picks: [action.optionId] };
        }
        return state;
      }
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

export function isPicked(state: BallotState, optionId: string): boolean {
  return state.picks.includes(optionId);
}

export function canSubmit(state: BallotState): boolean {
  return state.picks.length > 0;
}

/** The PUT /ballots body's `ranks`. */
export function toRanks(state: BallotState): { option_id: string; rank: number }[] {
  return state.picks.map((option_id, index) => ({ option_id, rank: index + 1 }));
}

/** What the phone tells the voter to do, per method. */
export function ballotPrompt(state: BallotState): { title: string; lede: string } {
  switch (state.method) {
    case "pick_one":
      return { title: "Pick one", lede: "Tap the one movie you want to watch." };
    case "approval":
      return {
        title: "Which would you watch?",
        lede: "Tap every movie you'd be happy with, then Done.",
      };
    case "top3":
      return {
        title: "Rank your favourites",
        lede:
          state.size === 1
            ? "Tap the one you want to watch."
            : `Tap your favourite first, then your next. Up to ${state.size} picks.`,
      };
  }
}

/** The live count under the posters. */
export function pickCount(state: BallotState): string {
  if (state.method === "approval") {
    return `${state.picks.length} ${state.picks.length === 1 ? "movie" : "movies"} picked`;
  }
  return `${state.picks.length} of ${state.size} picked`;
}
