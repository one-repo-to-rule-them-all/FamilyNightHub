import { describe, expect, it } from "vitest";

import { hereSummary, hereTonight, overflow, showHereStrip } from "./here-tonight";

const people = [
  { id: "g", name: "Tío", is_guest: true },
  { id: "a", name: "Ana", is_guest: false },
  { id: "b", name: "Beto", is_guest: false },
];
const avatar = { avatar_emoji: "🦊", color: "#3b82f6" };

describe("hereTonight", () => {
  it("uses attendance when the backend serves it, family first", () => {
    const items = hereTonight(
      [
        { person_id: "g", ...avatar, voted: false },
        { person_id: "a", ...avatar, voted: true },
      ],
      [],
      people,
    );
    expect(items.map((i) => [i.personId, i.name, i.voted])).toEqual([
      ["a", "Ana", true],
      ["g", "Tío", false],
    ]);
  });

  it("falls back to voters (all voted) without attendance", () => {
    const items = hereTonight(null, [{ person_id: "b", ...avatar }], people);
    expect(items).toEqual([
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
    const [item] = hereTonight(null, [{ person_id: "zz", ...avatar }], people);
    expect(item).toMatchObject({ name: null, isGuest: true });
  });
});

describe("strip", () => {
  const items = hereTonight(
    [
      { person_id: "a", ...avatar, voted: true },
      { person_id: "b", ...avatar, voted: false },
    ],
    [],
    people,
  );

  it("hides until someone else is here", () => {
    expect(showHereStrip(items.slice(0, 1), "a")).toBe(false);
    expect(showHereStrip(items, "a")).toBe(true);
  });

  it("counts here and voted, but never claims presence from voters alone", () => {
    expect(hereSummary(items, "voting", true)).toEqual({
      label: "Here tonight",
      count: "2 here · 1 voted",
    });
    expect(hereSummary(items, "tonight", true)).toEqual({ label: "Here tonight", count: "2 here" });
    expect(hereSummary(items, "voting", false)).toEqual({
      label: "Voted so far",
      count: "1 voted",
    });
  });

  it("collapses the rest into +N", () => {
    expect(overflow([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(overflow([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2], more: 3 });
  });
});
