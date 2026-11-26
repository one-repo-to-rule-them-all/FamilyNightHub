import { describe, expect, it } from "vitest";

import {
  bingoStatusLine,
  callParts,
  canTapSquare,
  markedSet,
  markedToGo,
  progressLabel,
  rankPlayers,
  squareLabel,
  winnerLine,
  winnerNames,
} from "./bingo";

const p = (name: string, left: number, place: number | null = null) => ({
  person_id: name,
  name,
  squares_from_bingo: left,
  won: place !== null,
  finish_place: place,
});

describe("bingo", () => {
  it("captions progress", () => {
    expect(progressLabel(p("a", 4))).toBe("4 to go");
    expect(progressLabel(p("a", 1))).toBe("1 away");
    expect(progressLabel(p("a", 0, 1))).toBe("Bingo!");
    expect(progressLabel({ squares_from_bingo: 0, won: false })).toBe("Bingo!");
  });

  it("ranks winners first by place, then by closeness, then by name", () => {
    const ranked = rankPlayers([
      p("Zed", 2),
      p("Amy", 2),
      p("Kim", 0, 2),
      p("Sam", 0, 1),
      p("Bo", 1),
    ]);
    expect(ranked.map((x) => x.name)).toEqual(["Sam", "Kim", "Bo", "Amy", "Zed"]);
  });

  it("does not mutate its input", () => {
    const input = [p("b", 2), p("a", 1)];
    rankPlayers(input);
    expect(input.map((x) => x.name)).toEqual(["b", "a"]);
  });

  it("names the winners", () => {
    expect(winnerNames([p("a", 3), p("b", 0, 2), p("c", 0, 1)])).toEqual(["c", "b"]);
    expect(winnerLine([])).toBeNull();
    expect(winnerLine(["Sam"])).toBe("Sam got bingo!");
    expect(winnerLine(["Sam", "Kim"])).toBe("Sam and Kim got bingo!");
    expect(winnerLine(["A", "B", "C"])).toBe("A, B and C got bingo!");
  });

  it("labels squares with position and state, never colour alone", () => {
    expect(squareLabel("Turkey", 7, true)).toBe("Row 2, column 3: Turkey, marked");
    expect(squareLabel("Gravy", 0, false)).toBe("Row 1, column 1: Gravy, not marked");
    expect(squareLabel("FREE", 12, true)).toBe("Row 3, column 3: free space, marked");
    expect(markedSet([1, 12]).has(12)).toBe(true);
  });

  it("allows taps only on a live round and never the free square", () => {
    expect(canTapSquare("live", "Turkey")).toBe(true);
    expect(canTapSquare("live", "FREE")).toBe(false);
    expect(canTapSquare("open", "Turkey")).toBe(false);
    expect(canTapSquare("ended", "Turkey")).toBe(false);
  });

  it("says where the round stands", () => {
    expect(bingoStatusLine("draft", false)).toMatch(/getting ready/);
    expect(bingoStatusLine("open", false)).toMatch(/seat/);
    expect(bingoStatusLine("open", true)).toMatch(/Waiting/);
    expect(bingoStatusLine("live", true)).toMatch(/Tap/);
    expect(bingoStatusLine("ended", true)).toMatch(/over/);
  });
});

import {
  boardRows,
  calledSet,
  canMarkClassic,
  checkResultLine,
  classicSquareLabel,
  classicStatusLine,
  notCalledMessage,
  patternName,
  winPatterns,
  recentCalls,
  spacedLabel,
  squareIsCalled,
} from "./bingo";

describe("classic bingo", () => {
  const call = (seq: number, value: number) => ({ seq, value, label: `X${value}` });

  it("spaces the letter from the number", () => {
    expect(spacedLabel({ label: "B7" })).toBe("B 7");
    expect(spacedLabel({ label: "G52" })).toBe("G 52");
  });

  it("builds the 5 x 15 board", () => {
    const rows = boardRows();
    expect(rows.map((r) => r.letter).join("")).toBe("BINGO");
    expect(rows.every((r) => r.values.length === 15)).toBe(true);
    expect(rows[0].values[0]).toBe(1);
    expect(rows[4].values[14]).toBe(75);
  });

  it("lists the five before the last call, newest first", () => {
    const calls = [1, 2, 3, 4, 5, 6, 7].map((v, i) => call(i, v));
    expect(recentCalls(calls).map((c) => c.value)).toEqual([6, 5, 4, 3, 2]);
    expect(recentCalls(calls.slice(0, 1))).toEqual([]);
    expect(recentCalls([])).toEqual([]);
  });

  it("only called numbers (and the free centre) can be marked, and only while live", () => {
    const called = calledSet([call(0, 7)]);
    expect(squareIsCalled("7", called)).toBe(true);
    expect(squareIsCalled("8", called)).toBe(false);
    expect(squareIsCalled("FREE", called)).toBe(true);
    expect(canMarkClassic("live", "7", called)).toBe(true);
    expect(canMarkClassic("live", "8", called)).toBe(false);
    expect(canMarkClassic("live", "FREE", called)).toBe(false);
    expect(canMarkClassic("open", "7", called)).toBe(false);
    expect(notCalledMessage("8")).toBe("8 hasn't been called yet.");
  });

  it("labels an uncalled square for screen readers", () => {
    expect(classicSquareLabel("8", 0, false, false)).toContain("not called yet");
    expect(classicSquareLabel("7", 0, true, true)).not.toContain("not called yet");
    expect(classicSquareLabel("FREE", 12, true, false)).not.toContain("not called yet");
  });

  it("describes the round for the phone", () => {
    expect(classicStatusLine("live", true, 0)).toMatch(/first number/);
    expect(classicStatusLine("live", true, 3)).toMatch(/Tap each number/);
    expect(classicStatusLine("live", false, 3)).toBe("The round is on.");
    expect(classicStatusLine("open", false, 0)).toBe(bingoStatusLine("open", false));
  });

  it("names the winning pattern for the host", () => {
    expect(patternName(null)).toBe("");
    expect(patternName([0, 1, 2, 3, 4])).toBe("top row");
    expect(patternName([10, 11, 12, 13, 14])).toBe("middle row");
    expect(patternName([2, 7, 12, 17, 22])).toBe("N column");
    expect(patternName([0, 6, 12, 18, 24])).toBe("diagonal");
    expect(patternName(Array.from({ length: 25 }, (_, i) => i))).toBe("the whole card");
  });

  it("words a check as a quiet message", () => {
    const base = { win_mode: "line" as const, pattern: null, missing: 2, valid: false };
    expect(checkResultLine("Sam", base)).toBe("Sam: not yet, 2 away.");
    expect(checkResultLine("Sam", { ...base, valid: true, pattern: [0, 1, 2, 3, 4] })).toBe(
      "Sam: valid, top row.",
    );
  });
});

describe("callParts", () => {
  it("splits a call into its letter and number", () => {
    expect(callParts({ label: "N34" })).toEqual({ letter: "N", number: "34" });
    expect(callParts({ label: "B7" })).toEqual({ letter: "B", number: "7" });
  });

  it("leaves anything else as the number", () => {
    expect(callParts({ label: "FREE" })).toEqual({ letter: "", number: "FREE" });
  });
});

describe("new win patterns", () => {
  it("has the right pattern shapes", () => {
    expect(winPatterns("corners")).toEqual([[0, 4, 20, 24]]);
    expect(winPatterns("x")[0]).toHaveLength(9);
    expect(winPatterns("stamp")).toEqual([
      [0, 1, 5, 6],
      [3, 4, 8, 9],
      [15, 16, 20, 21],
      [18, 19, 23, 24],
    ]);
  });

  it("counts squares to go with the free centre pre-marked", () => {
    expect(markedToGo([12], "corners")).toBe(4);
    expect(markedToGo([12, 0, 4, 20], "corners")).toBe(1);
    expect(markedToGo([12], "x")).toBe(8);
    expect(markedToGo([12, 0, 4, 6, 8, 16, 18, 20, 24], "x")).toBe(0);
    expect(markedToGo([12], "stamp")).toBe(4);
    expect(markedToGo([12, 18, 19, 23], "stamp")).toBe(1);
    expect(markedToGo([12, 3, 4, 8, 9], "stamp")).toBe(0);
  });

  it("names them for the host", () => {
    expect(patternName([0, 4, 20, 24])).toBe("four corners");
    expect(patternName([0, 4, 6, 8, 12, 16, 18, 20, 24])).toBe("the X");
    expect(patternName([18, 19, 23, 24])).toBe("postage stamp");
  });
});

describe("markedToGo", () => {
  it("counts the squares left to mark in the nearest line", () => {
    expect(markedToGo([12], "line")).toBe(4);
    expect(markedToGo([12, 0, 6], "line")).toBe(2);
    expect(markedToGo([0, 1, 2, 3, 4], "line")).toBe(0);
    expect(markedToGo([2, 7, 12, 17], "line")).toBe(1);
  });

  it("counts a blackout as every square", () => {
    expect(markedToGo([12], "blackout")).toBe(24);
    expect(
      markedToGo(
        Array.from({ length: 25 }, (_, i) => i),
        "blackout",
      ),
    ).toBe(0);
  });
});
