import { describe, expect, it } from "vitest";

import {
  bingoStripPlayers,
  jarStripPlayers,
  playerCountLabel,
  scatterStripPlayers,
  stripDensity,
  stripMaxRows,
  stripNameMaxEm,
  stripSticky,
  needsResultsPaging,
  nextPage,
  fitScale,
} from "./game-layout";

describe("stripDensity", () => {
  it("packs tighter as the head count grows", () => {
    expect(stripDensity(0)).toBe("roomy");
    expect(stripDensity(6)).toBe("roomy");
    expect(stripDensity(7)).toBe("compact");
    expect(stripDensity(12)).toBe("compact");
    expect(stripDensity(13)).toBe("dense");
    expect(stripDensity(40)).toBe("dense");
  });
});

describe("stripMaxRows", () => {
  it("keeps the phone strip to one scrolling row", () => {
    expect(stripMaxRows("phone", "roomy")).toBe(1);
    expect(stripMaxRows("phone", "dense")).toBe(1);
  });

  it("lets TV and host wrap, a little more when dense", () => {
    expect(stripMaxRows("tv", "roomy")).toBe(2);
    expect(stripMaxRows("host", "compact")).toBe(4);
    expect(stripMaxRows("host", "dense")).toBe(5);
  });
});

describe("playerCountLabel", () => {
  it("pluralises", () => {
    expect(playerCountLabel(1)).toBe("1 player");
    expect(playerCountLabel(0)).toBe("0 players");
    expect(playerCountLabel(3)).toBe("3 players");
  });
});

describe("bingoStripPlayers", () => {
  it("maps progress to the chip and flags winners", () => {
    const out = bingoStripPlayers([
      {
        person_id: "a",
        name: "Ana",
        avatar_emoji: "🦊",
        color: "#fff",
        squares_from_bingo: 1,
        won: false,
      },
      {
        person_id: "b",
        name: "Bo",
        avatar_emoji: "🐻",
        color: "#000",
        squares_from_bingo: 0,
        won: true,
      },
    ]);
    expect(out[0]).toMatchObject({ id: "a", name: "Ana", emoji: "🦊", highlight: false });
    expect(out[0]!.chip).toContain("1 away");
    expect(out[1]).toMatchObject({ id: "b", highlight: true });
  });
});

describe("bingoStripPlayers without progress", () => {
  it("drops the chip until a player wins", () => {
    const base = { avatar_emoji: "🦊", color: "#fff" };
    const out = bingoStripPlayers(
      [
        { ...base, person_id: "a", name: "Ana", squares_from_bingo: 1, won: false },
        { ...base, person_id: "b", name: "Bo", squares_from_bingo: 0, won: true },
      ],
      { progress: false },
    );
    expect(out[0]!.chip).toBeUndefined();
    expect(out[1]!.chip).toBe("Bingo!");
  });
});

describe("scatterStripPlayers", () => {
  const players = [{ person_id: "a", name: "Ana", avatar_emoji: "🦊", color: "#fff", answered: 2 }];

  it("shows answers in while a round runs", () => {
    expect(scatterStripPlayers(players, 5)[0]!.chip).toBe("2 of 5 answered");
  });

  it("has no chip between rounds", () => {
    expect(scatterStripPlayers(players, null)[0]!.chip).toBeUndefined();
  });
});

describe("jarStripPlayers", () => {
  const author = (id: string, name: string) => ({
    author: { person_id: id, name, avatar_emoji: "🙂", color: "#abc" },
  });

  it("lists each named author once and skips anonymous notes", () => {
    const out = jarStripPlayers([
      author("a", "Ana"),
      { author: null },
      author("a", "Ana"),
      author("b", "Bo"),
    ]);
    expect(out.map((p) => p.name)).toEqual(["Ana", "Bo"]);
  });

  it("is empty before anything is revealed", () => {
    expect(jarStripPlayers([])).toEqual([]);
  });
});

describe("stripNameMaxEm", () => {
  it("narrows the name column as the crowd grows", () => {
    expect(stripNameMaxEm("roomy")).toBeGreaterThan(stripNameMaxEm("compact"));
    expect(stripNameMaxEm("compact")).toBeGreaterThan(stripNameMaxEm("dense"));
  });
});

describe("fitScale", () => {
  it("is 1 when the content fits or is not measured", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 80, height: 90 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 80, height: 90 })).toBe(1);
  });
  it("shrinks to the tighter axis", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 100, height: 200 })).toBe(0.5);
    expect(fitScale({ width: 100, height: 300 }, { width: 200, height: 100 })).toBe(0.5);
  });
  it("never goes below the floor", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 100, height: 1000 })).toBe(0.4);
    expect(fitScale({ width: 100, height: 100 }, { width: 100, height: 1000 }, 0.6)).toBe(0.6);
  });
});

describe("stripSticky", () => {
  it("pins a short strip and lets a crowd's scroll with the page", () => {
    expect(stripSticky(4)).toBe(true);
    expect(stripSticky(8)).toBe(false);
  });
});

describe("results paging", () => {
  it("pages only a crowd's answers", () => {
    expect(needsResultsPaging(6)).toBe(false);
    expect(needsResultsPaging(18)).toBe(false);
    expect(needsResultsPaging(19)).toBe(true);
  });
  it("wraps", () => {
    expect(nextPage(0, 3)).toBe(1);
    expect(nextPage(2, 3)).toBe(0);
    expect(nextPage(0, 1)).toBe(0);
  });
});
