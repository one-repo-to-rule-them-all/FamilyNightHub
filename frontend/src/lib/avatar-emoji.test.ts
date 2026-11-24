import { describe, expect, it } from "vitest";

import { EMOJI_GROUPS, EMOJI_SUGGESTIONS, validatePerson } from "./admin";

describe("avatar emoji suggestions", () => {
  const graphemes = (value: string) =>
    [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)].length;

  it("offers 40+ emoji in the five themed groups", () => {
    expect(EMOJI_GROUPS.map((g) => g.name)).toEqual([
      "Animals",
      "Faces",
      "Food",
      "Sports",
      "Fantasy",
    ]);
    expect(EMOJI_SUGGESTIONS.length).toBeGreaterThanOrEqual(40);
    expect(EMOJI_SUGGESTIONS).toEqual(EMOJI_GROUPS.flatMap((g) => g.emoji));
  });

  it("has no duplicates", () => {
    expect(new Set(EMOJI_SUGGESTIONS).size).toBe(EMOJI_SUGGESTIONS.length);
  });

  it("is one pictographic grapheme each, which the API accepts", () => {
    for (const emoji of EMOJI_SUGGESTIONS) {
      expect(graphemes(emoji), emoji).toBe(1);
      expect(emoji, emoji).toMatch(/^\p{Extended_Pictographic}$/u);
      expect(validatePerson({ name: "Ana", avatarEmoji: emoji, color: "#336699" })).toEqual({});
    }
  });
});
