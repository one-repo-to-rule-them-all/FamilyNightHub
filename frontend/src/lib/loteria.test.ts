import { describe, expect, it } from "vitest";

import { KIND_COPY, kindName, PLAYABLE, statusLabel } from "./games";
import {
  calledSet,
  canMark,
  checkResultLine,
  loteriaStripPlayers,
  markedSet,
  notCalledMessage,
  progressLabel,
  rankPlayers,
  recentCalls,
  SHOUT,
  squareLabel,
  statusLine,
  winnerLine,
  winnerNames,
} from "./loteria";
import { cardById, DECK, DECK_SIZE } from "./loteria-deck";

const player = (name: string, missing: number, won = false, place: number | null = null) => ({
  person_id: name,
  name,
  avatar_emoji: "🙂",
  color: "#fff",
  missing,
  won,
  finish_place: place,
});

describe("the deck", () => {
  it("has 54 unique cards in order, each with a name and a picture", () => {
    expect(DECK_SIZE).toBe(54);
    expect(DECK.map((c) => c.id)).toEqual(Array.from({ length: 54 }, (_, i) => i + 1));
    expect(new Set(DECK.map((c) => c.es)).size).toBe(54);
    expect(new Set(DECK.map((c) => c.emoji)).size).toBe(54);
    expect(DECK.every((c) => c.en && c.emoji)).toBe(true);
    expect(cardById(1).es).toBe("El Gallo");
    expect(cardById(999).es).toBe("Carta 999");
  });
});

describe("loteria helpers", () => {
  it("describes progress and ranks winners first, then the closest", () => {
    expect(progressLabel({ missing: 0, won: false })).toBe(SHOUT);
    expect(progressLabel({ missing: 1, won: false })).toBe("1 away");
    expect(progressLabel({ missing: 4, won: false })).toBe("4 to go");
    const ranked = rankPlayers([
      player("Zed", 3),
      player("Amy", 3),
      player("Kim", 1),
      player("Sam", 0, true, 2),
      player("Ola", 0, true, 1),
    ]);
    expect(ranked.map((p) => p.name)).toEqual(["Ola", "Sam", "Kim", "Amy", "Zed"]);
    expect(winnerNames(ranked)).toEqual(["Ola", "Sam"]);
    expect(winnerLine([])).toBeNull();
    expect(winnerLine(["Sam"])).toBe(`Sam got ${SHOUT}`);
    expect(winnerLine(["A", "B", "C"])).toBe(`A, B and C got ${SHOUT}`);
  });

  it("tracks called cards and only lets a called one be marked while live", () => {
    const calls = [1, 2, 3, 4, 5, 6, 7].map((card_id, seq) => ({ seq, card_id }));
    const called = calledSet(calls);
    expect(called.has(3)).toBe(true);
    expect(recentCalls(calls).map((c) => c.card_id)).toEqual([6, 5, 4, 3, 2]);
    expect(recentCalls(calls.slice(0, 1))).toEqual([]);
    expect(canMark("live", 3, called)).toBe(true);
    expect(canMark("live", 40, called)).toBe(false);
    expect(canMark("open", 3, called)).toBe(false);
    expect(markedSet([1, 2]).has(2)).toBe(true);
  });

  it("labels squares and hints in words, not colour", () => {
    expect(squareLabel(6, 6, true, false)).toBe("Row 2, column 3: La Sirena, called, not marked");
    expect(squareLabel(6, 0, false, false)).toContain("not called yet");
    expect(notCalledMessage(6, "live")).toBe("La Sirena hasn't been called yet.");
    expect(notCalledMessage(6, "open")).toBe("The round hasn't started.");
    expect(statusLine("draft", false, 0)).toMatch(/getting ready/);
    expect(statusLine("open", true, 0)).toMatch(/Get another/);
    expect(statusLine("live", true, 0)).toMatch(/first card/);
    expect(statusLine("live", true, 9)).toMatch(/9 of 54/);
    expect(statusLine("ended", true, 9)).toMatch(/over/);
  });

  it("words a host check and builds strip chips (hidden progress on the TV)", () => {
    expect(checkResultLine("Sam", { valid: true, missing: 0 })).toContain("valid");
    expect(checkResultLine("Sam", { valid: false, missing: 1 })).toBe("Sam: not yet, 1 away.");
    expect(checkResultLine("Sam", { valid: false, missing: 3 })).toBe("Sam: not yet, 3 to go.");
    const hidden = loteriaStripPlayers([player("Kim", 2), player("Sam", 0, true, 1)], {
      progress: false,
    });
    expect(hidden.map((p) => p.chip)).toEqual([undefined, SHOUT]);
    expect(hidden[1]?.highlight).toBe(true);
    expect(loteriaStripPlayers([player("Kim", 2)])[0]?.chip).toBe("2 to go");
  });

  it("is registered as a playable kind", () => {
    expect(PLAYABLE).toContain("loteria");
    expect(KIND_COPY.loteria.name).toBe("Lotería");
    expect(kindName("loteria")).toBe("Lotería");
    expect(statusLabel("loteria", "live")).toBe("Playing");
    expect(statusLabel("loteria", "open")).toBe("Open");
    expect(statusLabel("loteria", "ended")).toBe("Finished");
  });
});
