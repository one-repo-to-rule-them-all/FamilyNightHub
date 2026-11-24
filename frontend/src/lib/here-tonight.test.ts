import { describe, expect, it } from "vitest";

import { hereCount, hereTonight, showHereStrip } from "./here-tonight";

const people = [
  { id: "g", name: "Tío", is_guest: true },
  { id: "a", name: "Ana", is_guest: false },
  { id: "b", name: "Beto", is_guest: false },
];
const avatar = { avatar_emoji: "🦊", color: "#3b82f6" };

describe("hereTonight", () => {
  it("puts family first, then guests, keeping the server's order", () => {
    const items = hereTonight(
      [
        { person_id: "g", ...avatar, voted: false },
        { person_id: "b", ...avatar, voted: false },
        { person_id: "a", ...avatar, voted: true },
      ],
      people,
    );
    expect(items.map((i) => [i.personId, i.name, i.voted])).toEqual([
      ["b", "Beto", false],
      ["a", "Ana", true],
      ["g", "Tío", false],
    ]);
  });

  it("maps a row to a tile", () => {
    expect(hereTonight([{ person_id: "b", ...avatar, voted: true }], people)).toEqual([
      {
        personId: "b",
        name: "Beto",
        ...{ avatarEmoji: "🦊", color: "#3b82f6" },
        voted: true,
        isGuest: false,
      },
    ]);
  });

  it("keeps someone the phone can't name, as a guest without a name", () => {
    const [item] = hereTonight([{ person_id: "zz", ...avatar, voted: false }], people);
    expect(item).toMatchObject({ name: null, isGuest: true });
  });
});

describe("strip", () => {
  const items = hereTonight(
    [
      { person_id: "a", ...avatar, voted: true },
      { person_id: "b", ...avatar, voted: false },
    ],
    people,
  );

  it("hides until someone else is here", () => {
    expect(showHereStrip(items.slice(0, 1), "a")).toBe(false);
    expect(showHereStrip(items, "a")).toBe(true);
  });

  it("counts here, and voted only while voting", () => {
    expect(hereCount(items, "voting")).toBe("2 here · 1 voted");
    expect(hereCount(items, "tonight")).toBe("2 here");
  });
});
