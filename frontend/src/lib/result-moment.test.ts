import { describe, expect, it } from "vitest";

import {
  hasSeen,
  markSeen,
  namesList,
  placedResult,
  pointsLabel,
  scatterResult,
  seenKey,
  setSoundEnabled,
  soundEnabled,
  whoWonLine,
} from "./result-moment";

const person = (id: string, name: string) => ({
  person_id: id,
  name,
  avatar_emoji: "🦃",
  color: "#f00",
});
const placed = (id: string, name: string, won: boolean, finish_place: number | null = null) => ({
  ...person(id, name),
  won,
  finish_place,
});

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}
const brokenStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("placedResult (bingo, classic bingo, Lotería)", () => {
  const players = [placed("a", "Ana", false), placed("b", "Ben", true, 1)];

  it("is null while the game is live, even with a winner", () => {
    expect(placedResult("live", "b", players, "Line")).toBeNull();
    expect(placedResult("open", "b", players, "Line")).toBeNull();
  });
  it("says won for the winner with the pattern", () => {
    const r = placedResult("ended", "b", players, "Line");
    expect(r?.outcome).toBe("won");
    expect(r?.detail).toBe("Line");
    expect(r?.winners.map((w) => w.name)).toEqual(["Ben"]);
  });
  it("says lost for a player who joined and did not win", () => {
    expect(placedResult("ended", "a", players, "Line")?.outcome).toBe("lost");
  });
  it("is null for someone who never joined, or no current person", () => {
    expect(placedResult("ended", "zed", players, "Line")).toBeNull();
    expect(placedResult("ended", null, players, "Line")).toBeNull();
  });
  it("is null when the game ended with no winner", () => {
    expect(placedResult("ended", "a", [placed("a", "Ana", false)], null)).toBeNull();
  });
  it("lists several winners in finishing order", () => {
    const many = [
      placed("c", "Cy", true, 2),
      placed("b", "Ben", true, 1),
      placed("a", "Ana", false),
    ];
    const r = placedResult("ended", "c", many, null);
    expect(r?.outcome).toBe("won");
    expect(r?.winners.map((w) => w.name)).toEqual(["Ben", "Cy"]);
  });
});

describe("scatterResult", () => {
  const joined = [person("a", "Ana"), person("b", "Ben"), person("c", "Cy")];
  const board = [
    { ...person("a", "Ana"), points: 5 },
    { ...person("b", "Ben"), points: 9 },
    { ...person("c", "Cy"), points: 9 },
  ];

  it("is null until the game ends", () => {
    expect(scatterResult("live", "b", joined, board)).toBeNull();
  });
  it("counts ties at the top as winners", () => {
    expect(scatterResult("ended", "b", joined, board)?.outcome).toBe("won");
    const r = scatterResult("ended", "c", joined, board);
    expect(r?.outcome).toBe("won");
    expect(r?.winners.map((w) => w.name)).toEqual(["Ben", "Cy"]);
    expect(r?.detail).toBe("9 points");
  });
  it("says lost below the top", () => {
    expect(scatterResult("ended", "a", joined, board)?.outcome).toBe("lost");
  });
  it("is null for a stranger, an empty board or nobody scoring", () => {
    expect(scatterResult("ended", "zed", joined, board)).toBeNull();
    expect(scatterResult("ended", "a", joined, [])).toBeNull();
    expect(scatterResult("ended", "a", joined, [{ ...person("a", "Ana"), points: 0 }])).toBeNull();
  });
});

describe("copy", () => {
  it("formats names, points and the who-won line", () => {
    expect(namesList([{ name: "A" }])).toBe("A");
    expect(namesList([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("A, B and C");
    expect(pointsLabel(1)).toBe("1 point");
    expect(pointsLabel(3)).toBe("3 points");
    expect(whoWonLine([{ name: "Sam" }, { name: "Kim" }])).toBe("Sam and Kim won this one.");
  });
});

describe("once-per-game guard", () => {
  it("is unseen, then seen per person and game", () => {
    const store = memoryStore();
    expect(hasSeen("g1", "a", store)).toBe(false);
    markSeen("g1", "a", store);
    expect(hasSeen("g1", "a", store)).toBe(true);
    expect(hasSeen("g1", "b", store)).toBe(false);
    expect(hasSeen("g2", "a", store)).toBe(false);
    expect(seenKey("g1", "a")).toBe("fn:result-moment:g1:a");
  });
  it("never throws when storage is blocked", () => {
    expect(hasSeen("g1", "a", brokenStore)).toBe(false);
    expect(() => markSeen("g1", "a", brokenStore)).not.toThrow();
    expect(soundEnabled(brokenStore)).toBe(false);
    expect(() => setSoundEnabled(true, brokenStore)).not.toThrow();
  });
  it("sound is off by default and remembered per device", () => {
    const store = memoryStore();
    expect(soundEnabled(store)).toBe(false);
    setSoundEnabled(true, store);
    expect(soundEnabled(store)).toBe(true);
  });
});
