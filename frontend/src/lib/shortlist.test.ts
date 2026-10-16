import { describe, expect, it } from "vitest";

import {
  ballotSize,
  canAddOption,
  canOpenVoting,
  moveOption,
  shortlistReducer,
  toggleRank,
  toRanks,
} from "./shortlist";

describe("moveOption", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves up and down by one", () => {
    expect(moveOption(ids, "c", -1)).toEqual(["a", "c", "b", "d"]);
    expect(moveOption(ids, "a", 1)).toEqual(["b", "a", "c", "d"]);
  });

  it("clamps at the ends and returns the same array when nothing moves", () => {
    expect(moveOption(ids, "a", -1)).toBe(ids);
    expect(moveOption(ids, "d", 1)).toBe(ids);
    expect(moveOption(ids, "b", 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveOption(ids, "zz", 1)).toBe(ids);
    expect(moveOption(ids, "b", 0)).toBe(ids);
  });

  it("never loses or duplicates an id", () => {
    for (const id of ids) {
      for (const delta of [-3, -1, 1, 3]) {
        expect([...moveOption(ids, id, delta)].sort()).toEqual(ids);
      }
    }
  });
});

describe("shortlistReducer", () => {
  it("moves locally, then takes the server's order back on sync", () => {
    let state = { ids: ["a", "b", "c"] };
    state = shortlistReducer(state, { type: "move", id: "c", delta: -2 });
    expect(state.ids).toEqual(["c", "a", "b"]);
    // A failed PUT: the server still has the old order.
    state = shortlistReducer(state, { type: "sync", ids: ["a", "b", "c"] });
    expect(state.ids).toEqual(["a", "b", "c"]);
  });

  it("keeps the same state object when nothing changes", () => {
    const state = { ids: ["a", "b"] };
    expect(shortlistReducer(state, { type: "sync", ids: ["a", "b"] })).toBe(state);
    expect(shortlistReducer(state, { type: "move", id: "a", delta: -1 })).toBe(state);
    expect(shortlistReducer(state, { type: "remove", id: "zz" })).toBe(state);
  });

  it("removes optimistically", () => {
    expect(shortlistReducer({ ids: ["a", "b", "c"] }, { type: "remove", id: "b" }).ids).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("shortlist bounds (2..8, ADR-0006)", () => {
  it("opens voting only with 2 to 8 titles", () => {
    expect([0, 1, 2, 5, 8, 9].map(canOpenVoting)).toEqual([false, false, true, true, true, false]);
  });

  it("stops adding at 8", () => {
    expect(canAddOption(7)).toBe(true);
    expect(canAddOption(8)).toBe(false);
  });

  it("ballot size is min(3, n - 1)", () => {
    expect([1, 2, 3, 4, 8].map(ballotSize)).toEqual([0, 1, 2, 3, 3]);
  });
});

describe("toggleRank", () => {
  it("ranks in tap order up to k, and a second tap clears and closes the gap", () => {
    let ranked: string[] = [];
    ranked = toggleRank(ranked, "x", 3);
    ranked = toggleRank(ranked, "y", 3);
    ranked = toggleRank(ranked, "z", 3);
    expect(ranked).toEqual(["x", "y", "z"]);
    expect(toggleRank(ranked, "w", 3)).toBe(ranked); // full
    ranked = toggleRank(ranked, "x", 3);
    expect(toRanks(ranked)).toEqual([
      { option_id: "y", rank: 1 },
      { option_id: "z", rank: 2 },
    ]);
  });

  it("a shortlist of two is pick-one", () => {
    expect(toggleRank(toggleRank([], "a", 1), "b", 1)).toEqual(["a"]);
  });
});
