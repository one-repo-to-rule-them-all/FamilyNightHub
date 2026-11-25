import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  answerBody,
  answeredLine,
  answerNote,
  autoAcceptedLine,
  byCategory,
  canAnswer,
  canStartRound,
  categoriesToText,
  clockOffsetMs,
  countedSeparately,
  draftFrom,
  formatClock,
  informationalLabel,
  isDirty,
  letterHint,
  nextVerdict,
  normalize,
  parseCategories,
  pointsLabel,
  reviewTitle,
  roundHeading,
  secondsLeft,
  sendableText,
  startsWithLetter,
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

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../backend/tests/vectors/scatter_normalize.json", import.meta.url),
    ),
    "utf-8",
  ),
) as {
  normalize: { text: string; key: string }[];
  starts_with: { text: string; letter: string; ok: boolean }[];
};

describe("scatter phone validation (a convenience; the server decides)", () => {
  it("normalises exactly as the server does, on the shared vectors", () => {
    for (const v of vectors.normalize)
      expect(normalize(v.text), JSON.stringify(v.text)).toBe(v.key);
  });

  it("checks the first letter on the shared vectors", () => {
    for (const v of vectors.starts_with) {
      expect(startsWithLetter(v.text, v.letter), JSON.stringify(v.text)).toBe(v.ok);
    }
  });

  it("hints only when something is typed and it is wrong", () => {
    expect(letterHint("", "P")).toBeNull();
    expect(letterHint("   ", "P")).toBeNull();
    expect(letterHint("Pie", "P")).toBeNull();
    expect(letterHint("Apple", "P")).toBe("Must start with P");
  });

  it("sends a failing answer as blank and keeps the field dirty-free", () => {
    expect(sendableText(" Pie ", "P")).toBe("Pie");
    expect(sendableText("Apple", "P")).toBe("");
    expect(sendableText(" Apple ")).toBe("Apple");
    expect(answerBody(["Pie", "Apple", ""], "P")).toEqual([
      { category_index: 0, text: "Pie" },
      { category_index: 1, text: "" },
      { category_index: 2, text: "" },
    ]);
    // The wrong-letter text never reaches the server, so it is not "unsaved".
    expect(isDirty(["Apple"], [""], "P")).toBe(false);
    expect(isDirty(["Pie"], [""], "P")).toBe(true);
  });
});

describe("scatter review labels", () => {
  it("names each card and counts", () => {
    expect(reviewTitle("short", false)).toBe("Very short answer");
    expect(reviewTitle("near_duplicate", true)).toBe("Nearly the same answer");
    expect(reviewTitle("near_duplicate", false)).toBe("Possible typo");
    expect(reviewTitle("duplicate", false)).toBe("Exact duplicate");
    expect(reviewTitle("host_rejected", false)).toBe("You rejected");
    expect(reviewTitle("auto_rejected_letter", false)).toBe("Wrong letter");
    expect(autoAcceptedLine(1)).toBe("1 answer accepted automatically");
    expect(autoAcceptedLine(5)).toBe("5 answers accepted automatically");
    expect(informationalLabel(3)).toBe("Wrong letter and exact duplicates (3)");
    expect(countedSeparately([])).toBe(false);
    expect(countedSeparately([{ verdict: "accepted" }, { verdict: null }])).toBe(false);
    expect(countedSeparately([{ verdict: "accepted" }, { verdict: "accepted" }])).toBe(true);
  });
});
