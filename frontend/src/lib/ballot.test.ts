import { describe, expect, it } from "vitest";

import {
  type BallotAction,
  ballotReducer,
  type BallotState,
  canSubmit,
  initialBallot,
  rankOf,
  toRanks,
} from "./ballot";

const tap = (optionId: string): BallotAction => ({ type: "tap", optionId });
const run = (state: BallotState, ...actions: BallotAction[]) =>
  actions.reduce(ballotReducer, state);

describe("ballotReducer", () => {
  it("starts empty and can't be submitted", () => {
    const state = initialBallot(3);
    expect(state).toEqual({ picks: [], size: 3 });
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
    expect(state).toEqual({ picks: [], size: 3 });
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
