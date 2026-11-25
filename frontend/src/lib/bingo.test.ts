import { describe, expect, it } from "vitest";

import {
  bingoStatusLine,
  canTapSquare,
  markedSet,
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
