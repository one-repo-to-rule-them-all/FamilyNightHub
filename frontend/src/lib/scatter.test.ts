import { describe, expect, it } from "vitest";

import {
  answerBody,
  answeredLine,
  answerNote,
  byCategory,
  canAnswer,
  canStartRound,
  categoriesToText,
  clockOffsetMs,
  draftFrom,
  formatClock,
  isDirty,
  nextVerdict,
  parseCategories,
  pointsLabel,
  roundHeading,
  secondsLeft,
  stateLabel,
  timeFraction,
} from "./scatter";

describe("scatter clock", () => {
  it("counts down against the server's clock, not the device's", () => {
    // The phone's clock runs 10 s behind the server's.
    const offset = clockOffsetMs("2026-11-26T18:00:10Z", Date.parse("2026-11-26T18:00:00Z"));
    expect(offset).toBe(10_000);
    const ends = "2026-11-26T18:01:10Z";
    expect(secondsLeft(ends, offset, Date.parse("2026-11-26T18:00:00Z"))).toBe(60);
    expect(secondsLeft(ends, offset, Date.parse("2026-11-26T18:00:00.400Z"))).toBe(60);
    expect(secondsLeft(ends, offset, Date.parse("2026-11-26T18:00:59.100Z"))).toBe(1);
    expect(secondsLeft(ends, offset, Date.parse("2026-11-26T18:01:00Z"))).toBe(0);
    expect(secondsLeft(ends, offset, Date.parse("2026-11-26T18:05:00Z"))).toBe(0);
  });

  it("formats the clock and the bar", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(-3)).toBe("0:00");
    expect(timeFraction(30, 120)).toBe(0.25);
    expect(timeFraction(500, 120)).toBe(1);
    expect(timeFraction(-1, 120)).toBe(0);
    expect(timeFraction(5, 0)).toBe(0);
  });

  it("allows answers only while the round runs and time remains", () => {
    expect(canAnswer("running", 5)).toBe(true);
    expect(canAnswer("running", 0)).toBe(false);
    expect(canAnswer("closed", 5)).toBe(false);
    expect(canAnswer("revealed", 5)).toBe(false);
    expect(canAnswer("lobby", 5)).toBe(false);
  });

  it("words the round's state", () => {
    expect(stateLabel("lobby", 0)).toBe("Waiting for the host");
    expect(stateLabel("revealed", 0)).toBe("Answers revealed");
    expect(stateLabel("closed", 0)).toBe("Time is up");
    expect(stateLabel("running", 0)).toBe("Time is up");
    expect(stateLabel("running", 12)).toBe("Go!");
  });
});

describe("scatter host list", () => {
  it("parses one category per line, deduping and capping", () => {
    expect(parseCategories("  Pie  flavors \n\npie flavors\nSides\n")).toEqual([
      "Pie flavors",
      "Sides",
    ]);
    const many = Array.from({ length: 20 }, (_, i) => `c${i}`).join("\n");
    expect(parseCategories(many)).toHaveLength(12);
    expect(categoriesToText(["a", "b"])).toBe("a\nb");
    expect(canStartRound([])).toBe(false);
    expect(canStartRound(["a"])).toBe(true);
    expect(canStartRound(Array.from({ length: 13 }, () => "x"))).toBe(false);
  });
});

describe("scatter answers", () => {
  it("builds the PUT body and the starting draft", () => {
    expect(answerBody([" Pie ", ""])).toEqual([
      { category_index: 0, text: "Pie" },
      { category_index: 1, text: "" },
    ]);
    expect(
      draftFrom(3, [
        { category_index: 1, text: "Yam" },
        { category_index: 9, text: "x" },
      ]),
    ).toEqual(["", "Yam", ""]);
    expect(isDirty(["a", ""], ["a", ""])).toBe(false);
    expect(isDirty(["a ", ""], ["a", ""])).toBe(false);
    expect(isDirty(["b", ""], ["a", ""])).toBe(true);
    expect(isDirty(["a"], ["a", ""])).toBe(true);
    expect(isDirty(["a", "b"], ["a"])).toBe(true);
    expect(answeredLine(3, 6)).toBe("3 of 6 answered");
    expect(roundHeading(2, "P")).toBe("Round 2 · letter P");
  });
});

describe("scatter results", () => {
  const a = (category_index: number, person_id = "p") => ({ category_index, person_id });
  it("groups answers under their category in order", () => {
    const grouped = byCategory(["One", "Two"], [a(1), a(0), a(1, "q")]);
    expect(grouped.map((g) => [g.category, g.answers.length])).toEqual([
      ["One", 1],
      ["Two", 2],
    ]);
  });

  it("explains a zero and flips the verdict", () => {
    expect(answerNote({ valid: true, point: 1, verdict: null })).toBe("");
    expect(answerNote({ valid: true, point: 0, verdict: null })).toBe("Someone else had it");
    expect(answerNote({ valid: false, point: 0, verdict: null })).toBe("Wrong letter");
    expect(answerNote({ valid: false, point: 0, verdict: "rejected" })).toBe("Host rejected");
    expect(nextVerdict(null)).toBe("rejected");
    expect(nextVerdict("accepted")).toBe("rejected");
    expect(nextVerdict("rejected")).toBe("accepted");
    expect(pointsLabel(1)).toBe("1 pt");
    expect(pointsLabel(0)).toBe("0 pts");
  });
});
