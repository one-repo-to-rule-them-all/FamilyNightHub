import { describe, expect, it } from "vitest";

import {
  nameList,
  parseWindow,
  type ReelItem,
  reelIndex,
  reelProgress,
  slideSummary,
  winnerHeadline,
} from "./reel";

const reel = {
  server_now: "2026-11-26T20:00:24.000Z",
  anchor: "2026-11-26T00:00:00.000Z",
  dwell_seconds: 12,
};
const person = (name: string) => ({ person_id: name, name, avatar_emoji: "🐙", color: "#fff" });
const base: ReelItem = {
  kind: "winner",
  id: "x",
  winners: [],
  standings: [],
};

describe("reelIndex", () => {
  const fetched = Date.parse("2026-11-26T20:00:24.000Z"); // the device clock equals the server's
  it("advances one slide per dwell from the anchor and wraps", () => {
    const at = (secs: number) => reelIndex(fetched + secs * 1000, reel, fetched, 5);
    const start = at(0);
    expect(at(11)).toBe(start);
    expect(at(12)).toBe((start + 1) % 5);
    expect(at(12 * 5)).toBe(start);
  });
  it("corrects for a device clock that is off, using the offset taken at fetch time", () => {
    const skewed = fetched - 3_600_000; // this device is an hour behind
    expect(reelIndex(skewed + 12_000, reel, skewed, 7)).toBe(
      reelIndex(fetched + 12_000, reel, fetched, 7),
    );
  });
  it("is 0 for an empty reel", () => {
    expect(reelIndex(fetched, reel, fetched, 0)).toBe(0);
  });
});

describe("words", () => {
  it("parses the window, defaulting to tonight", () => {
    expect(parseWindow("all")).toBe("all");
    expect(parseWindow("week")).toBe("tonight");
    expect(parseWindow(null)).toBe("tonight");
  });
  it("counts slides 1-based and says nothing for none", () => {
    expect(reelProgress(2, 14)).toBe("3 of 14");
    expect(reelProgress(0, 0)).toBe("");
  });
  it("lists names", () => {
    expect(nameList([])).toBe("");
    expect(nameList(["Ana"])).toBe("Ana");
    expect(nameList(["Ana", "Ben"])).toBe("Ana and Ben");
    expect(nameList(["Ana", "Ben", "Cy"])).toBe("Ana, Ben and Cy");
  });
  it("heads winner slides by game and place", () => {
    const bingo = { ...base, game_kind: "bingo", winners: [person("Ana")], place: 1 };
    expect(winnerHeadline(bingo)).toBe("Ana got BINGO!");
    expect(winnerHeadline({ ...bingo, place: 2 })).toBe("Ana got bingo, second!");
    const round = { ...base, game_kind: "scattergories", winners: [person("Ana"), person("Ben")] };
    expect(winnerHeadline(round)).toBe("Ana and Ben tied for the win!");
    expect(winnerHeadline({ ...round, winners: [person("Ana")] })).toBe("Ana won the round!");
  });
  it("summarises every slide kind", () => {
    expect(slideSummary({ ...base, kind: "quote", body: "Pie" })).toBe("Pie");
    expect(
      slideSummary({
        ...base,
        kind: "leaderboard",
        game_title: "Letters",
        standings: [{ person: person("Ana"), points: 9 }],
      }),
    ).toBe("Letters: Ana 9");
    expect(slideSummary({ ...base, kind: "photo", photo_by: person("Cy") })).toBe(
      "A photo from Cy",
    );
  });
});
