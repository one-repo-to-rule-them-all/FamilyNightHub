import { describe, expect, it } from "vitest";

import {
  type BallotAction,
  ballotPrompt,
  ballotReducer,
  type BallotState,
  canSubmit,
  initialBallot,
  isPicked,
  pickCount,
  rankOf,
  toRanks,
} from "./ballot";

const tap = (optionId: string): BallotAction => ({ type: "tap", optionId });
const run = (state: BallotState, ...actions: BallotAction[]) =>
  actions.reduce(ballotReducer, state);

describe("ballotReducer", () => {
  it("starts empty and can't be submitted", () => {
    const state = initialBallot(3);
    expect(state).toEqual({ method: "top3", picks: [], size: 3 });
    expect(canSubmit(state)).toBe(false);
    expect(toRanks(state)).toEqual([]);
  });

  it("clamps a negative size to zero", () => {
    expect(initialBallot(-1).size).toBe(0);
  });

  it("ranks taps in order: first tap is 1, then 2, then 3", () => {
    const state = run(initialBallot(3), tap("a"), tap("b"), tap("c"));
    expect(rankOf(state, "a")).toBe(1);
    expect(rankOf(state, "b")).toBe(2);
    expect(rankOf(state, "c")).toBe(3);
    expect(rankOf(state, "d")).toBeNull();
    expect(toRanks(state)).toEqual([
      { option_id: "a", rank: 1 },
      { option_id: "b", rank: 2 },
      { option_id: "c", rank: 3 },
    ]);
  });

  it("allows Done after the first tap (partial ballot)", () => {
    const state = run(initialBallot(3), tap("a"));
    expect(canSubmit(state)).toBe(true);
    expect(toRanks(state)).toEqual([{ option_id: "a", rank: 1 }]);
  });

  it("ignores taps once the ballot is full, returning the same state", () => {
    const full = run(initialBallot(2), tap("a"), tap("b"));
    expect(ballotReducer(full, tap("c"))).toBe(full);
  });

  it("respects a ballot_size of 1 (a two-movie shortlist is pick-one)", () => {
    const state = run(initialBallot(1), tap("a"), tap("b"));
    expect(state.picks).toEqual(["a"]);
  });

  it("clears a ranked poster on a second tap and closes the gap", () => {
    const state = run(initialBallot(3), tap("a"), tap("b"), tap("c"), tap("a"));
    expect(toRanks(state)).toEqual([
      { option_id: "b", rank: 1 },
      { option_id: "c", rank: 2 },
    ]);
    // The freed rank goes to the next tap.
    expect(rankOf(ballotReducer(state, tap("a")), "a")).toBe(3);
  });

  it("clearing the only pick disables Done again", () => {
    const state = run(initialBallot(3), tap("a"), tap("a"));
    expect(canSubmit(state)).toBe(false);
  });

  it("clear empties the ballot", () => {
    const state = run(initialBallot(3), tap("a"), tap("b"), { type: "clear" });
    expect(state).toEqual({ method: "top3", picks: [], size: 3 });
  });

  it("loads a saved ballot in rank order, dropping duplicates and anything past size", () => {
    const state = ballotReducer(initialBallot(2), {
      type: "load",
      ranks: [
        { option_id: "c", rank: 3 },
        { option_id: "a", rank: 1 },
        { option_id: "a", rank: 2 },
        { option_id: "b", rank: 2 },
      ],
    });
    expect(state.picks).toEqual(["a", "b"]);
  });

  it("loads an empty saved ballot as an empty one", () => {
    const state = run(initialBallot(3), tap("a"), { type: "load", ranks: [] });
    expect(state.picks).toEqual([]);
  });
});

describe("pick_one", () => {
  it("a tap picks one poster and a second poster replaces it", () => {
    const state = run(initialBallot(1, "pick_one"), tap("a"), tap("b"));
    expect(state.picks).toEqual(["b"]);
    expect(isPicked(state, "b")).toBe(true);
    expect(isPicked(state, "a")).toBe(false);
    expect(toRanks(state)).toEqual([{ option_id: "b", rank: 1 }]);
  });

  it("tapping the picked poster clears it", () => {
    const state = run(initialBallot(1, "pick_one"), tap("a"), tap("a"));
    expect(canSubmit(state)).toBe(false);
  });

  it("does nothing with a zero size (a night not yet open)", () => {
    const empty = initialBallot(0, "pick_one");
    expect(ballotReducer(empty, tap("a"))).toBe(empty);
  });

  it("asks for one movie", () => {
    const state = run(initialBallot(1, "pick_one"), tap("a"));
    expect(ballotPrompt(state).title).toBe("Pick one");
    expect(pickCount(state)).toBe("1 of 1 picked");
  });
});

describe("approval", () => {
  it("toggles any number of posters on and off", () => {
    const state = run(initialBallot(4, "approval"), tap("a"), tap("c"), tap("d"), tap("a"));
    expect(state.picks).toEqual(["c", "d"]);
    expect(toRanks(state)).toEqual([
      { option_id: "c", rank: 1 },
      { option_id: "d", rank: 2 },
    ]);
  });

  it("can approve the whole shortlist", () => {
    const state = run(initialBallot(3, "approval"), tap("a"), tap("b"), tap("c"));
    expect(state.picks).toEqual(["a", "b", "c"]);
    expect(ballotReducer(state, tap("z"))).toBe(state);
    expect(pickCount(state)).toBe("3 movies picked");
  });

  it("needs at least one approval before Done", () => {
    const state = initialBallot(3, "approval");
    expect(canSubmit(state)).toBe(false);
    expect(pickCount(run(state, tap("a")))).toBe("1 movie picked");
    expect(ballotPrompt(state).title).toBe("Which would you watch?");
  });
});

describe("ballotPrompt for top3", () => {
  it("says how many picks, or one when k is 1", () => {
    expect(ballotPrompt(initialBallot(3)).lede).toContain("Up to 3 picks");
    expect(ballotPrompt(initialBallot(1)).lede).toBe("Tap the one you want to watch.");
    expect(ballotPrompt(initialBallot(3)).title).toBe("Rank your favourites");
  });
});
