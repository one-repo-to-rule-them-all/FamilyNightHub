import { describe, expect, it } from "vitest";

import { scoreLabel, tiebreakNote, VOTING_METHODS } from "./voting-method";

describe("VOTING_METHODS", () => {
  it("lists every method once with a one-line explanation", () => {
    expect(VOTING_METHODS.map((m) => m.value)).toEqual(["top3", "approval", "pick_one"]);
    for (const method of VOTING_METHODS) expect(method.explanation).not.toContain("\n");
  });
});

describe("scoreLabel", () => {
  it.each([
    ["top3", 1, "1 point"],
    ["top3", 6, "6 points"],
    ["approval", 1, "1 approval"],
    ["approval", 0, "0 approvals"],
    ["pick_one", 1, "1 vote"],
    ["pick_one", 3, "3 votes"],
  ] as const)("%s %d → %s", (method, score, label) => {
    expect(scoreLabel(method, score)).toBe(label);
  });
});

describe("tiebreakNote", () => {
  it("is empty without a tie", () => {
    expect(tiebreakNote("top3", "none")).toBeNull();
  });

  it("names the step that settled it, in the method's terms", () => {
    expect(tiebreakNote("top3", "first_places")).toBe("Tie broken by first-place votes");
    expect(tiebreakNote("approval", "first_places")).toBe(
      "Tie broken by who was picked alone most often",
    );
    expect(tiebreakNote("top3", "head_to_head")).toBe("Tie broken head-to-head");
    expect(tiebreakNote("pick_one", "random")).toBe("Tie broken by a coin flip");
  });
});
