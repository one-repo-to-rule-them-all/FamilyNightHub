import { describe, expect, it } from "vitest";

import {
  AGE_CAPS,
  MAX_STREAMING_PROVIDERS,
  PERSON_COLORS,
  ageCapFromSelect,
  cleanName,
  colorChoices,
  describeMerge,
  deviceName,
  lastSeen,
  normalizeRegion,
  personChanges,
  sameIds,
  toggleProvider,
  validatePerson,
} from "./admin";

const NO_MOVES = {
  ballot_ranks_moved: 0,
  ballot_ranks_dropped: 0,
  ratings_moved: 0,
  ratings_dropped: 0,
  photos_moved: 0,
  reactions_moved: 0,
  reactions_dropped: 0,
  bindings_moved: 0,
  bindings_dropped: 0,
};

describe("colorChoices", () => {
  it("is the palette, all lowercase #rrggbb", () => {
    expect(colorChoices()).toEqual([...PERSON_COLORS]);
    for (const c of PERSON_COLORS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps a palette colour as-is, whatever its case", () => {
    expect(colorChoices("#EC4899")).toHaveLength(PERSON_COLORS.length);
  });

  it("adds an off-palette current colour so editing doesn't silently change it", () => {
    const choices = colorChoices("#ABCDEF");
    expect(choices).toHaveLength(PERSON_COLORS.length + 1);
    expect(choices.at(-1)).toEqual({ name: "Current colour", value: "#abcdef" });
  });
});

describe("cleanName", () => {
  it("trims and collapses whitespace like the API", () => {
    expect(cleanName("  Sam   B ")).toBe("Sam B");
    expect(cleanName("   ")).toBe("");
  });
});

describe("validatePerson", () => {
  const ok = { name: "Sam", avatarEmoji: "🦊", color: "#3b82f6" };

  it("accepts a name, an emoji and a colour", () => {
    expect(validatePerson(ok)).toEqual({});
    expect(validatePerson({ ...ok, avatarEmoji: "👨‍👩‍👧" })).toEqual({});
    expect(validatePerson({ ...ok, avatarEmoji: "1️⃣" })).toEqual({});
  });

  it("needs a name of at most 60 characters", () => {
    expect(validatePerson({ ...ok, name: "  " }).name).toBe("Give them a name.");
    expect(validatePerson({ ...ok, name: "x".repeat(61) }).name).toBe("Keep it to 60 characters.");
    expect(validatePerson({ ...ok, name: "x".repeat(60) }).name).toBeUndefined();
  });

  it("refuses words, blanks, spaces and long strings as the avatar", () => {
    for (const avatarEmoji of ["", "ab", "🦊 🐼", "🦊".repeat(17)]) {
      expect(validatePerson({ ...ok, avatarEmoji }).avatarEmoji).toBe("Pick one emoji.");
    }
  });

  it("needs a #rrggbb colour", () => {
    expect(validatePerson({ ...ok, color: "" }).color).toBe("Pick a colour.");
    expect(validatePerson({ ...ok, color: "#ABCDEF" }).color).toBeUndefined();
  });
});

describe("personChanges", () => {
  const original = { name: "Sam", avatar_emoji: "🦊", color: "#3b82f6" };

  it("is null when nothing changed (case and spacing included)", () => {
    expect(personChanges(original, { name: " Sam ", avatarEmoji: "🦊 ", color: "#3B82F6" })).toBe(
      null,
    );
  });

  it("sends only the changed fields, cleaned", () => {
    expect(
      personChanges(original, { name: "Sammy  B", avatarEmoji: "🦊", color: "#3b82f6" }),
    ).toEqual({ name: "Sammy B" });
    expect(personChanges(original, { name: "Sam", avatarEmoji: "🐼", color: "#EC4899" })).toEqual({
      avatar_emoji: "🐼",
      color: "#ec4899",
    });
  });
});

describe("describeMerge", () => {
  it("lists what moved, singular and plural", () => {
    expect(
      describeMerge(
        { ...NO_MOVES, ballot_ranks_moved: 3, ratings_moved: 1, photos_moved: 2 },
        "Sam",
      ),
    ).toBe("Moved 3 ballot picks, 1 rating and 2 photos to Sam.");
    expect(describeMerge({ ...NO_MOVES, bindings_moved: 1 }, "Sam")).toBe("Moved 1 phone to Sam.");
    expect(describeMerge({ ...NO_MOVES, reactions_moved: 2, bindings_moved: 2 }, "Sam")).toBe(
      "Moved 2 reactions and 2 phones to Sam.",
    );
  });

  it("says when there was nothing to move", () => {
    expect(describeMerge(NO_MOVES, "Sam")).toBe("Nothing to move: Sam is unchanged.");
  });

  it("adds what collided with the target's own rows", () => {
    expect(
      describeMerge(
        {
          ...NO_MOVES,
          photos_moved: 1,
          ballot_ranks_dropped: 3,
          ratings_dropped: 1,
          reactions_dropped: 2,
          bindings_dropped: 1,
        },
        "Sam",
      ),
    ).toBe(
      "Moved 1 photo to Sam. Dropped 3 ballot picks, 1 rating, 2 reactions and 1 phone link that Sam already had.",
    );
  });
});

describe("deviceName", () => {
  it("prefers the label, else says what it is", () => {
    expect(deviceName({ label: "Ava's phone", is_tv: false })).toBe("Ava's phone");
    expect(deviceName({ label: null, is_tv: true })).toBe("Living-room TV");
    expect(deviceName({ label: null, is_tv: false })).toBe("Unnamed phone");
  });
});

describe("lastSeen", () => {
  const now = new Date("2026-10-15T20:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("phrases the gap", () => {
    expect(lastSeen(null, now)).toBe("Never");
    expect(lastSeen(ago(30_000), now)).toBe("Just now");
    expect(lastSeen(ago(-5_000), now)).toBe("Just now");
    expect(lastSeen(ago(5 * 60_000), now)).toBe("5 min ago");
    expect(lastSeen(ago(3 * 3_600_000), now)).toBe("3 h ago");
    expect(lastSeen(ago(26 * 3_600_000), now)).toBe("1 day ago");
    expect(lastSeen(ago(9 * 86_400_000), now)).toBe("9 days ago");
  });
});

describe("settings helpers", () => {
  it("maps the age-cap select, 'none' and junk to no cap", () => {
    for (const cap of AGE_CAPS) expect(ageCapFromSelect(cap)).toBe(cap);
    expect(ageCapFromSelect("none")).toBe(null);
    expect(ageCapFromSelect("X")).toBe(null);
  });

  it("normalizes a two-letter region", () => {
    expect(normalizeRegion(" gb ")).toBe("GB");
    expect(normalizeRegion("USA")).toBe(null);
    expect(normalizeRegion("1A")).toBe(null);
  });
});

describe("toggleProvider", () => {
  it("ticks (sorted) and unticks", () => {
    expect(toggleProvider([8, 337], 15)).toEqual([8, 15, 337]);
    expect(toggleProvider([8, 15, 337], 15)).toEqual([8, 337]);
  });

  it("stops at the limit but can still untick there", () => {
    const full = Array.from({ length: MAX_STREAMING_PROVIDERS }, (_, i) => i + 1);
    expect(toggleProvider(full, 99)).toEqual(full);
    expect(toggleProvider(full, 1)).toHaveLength(MAX_STREAMING_PROVIDERS - 1);
    expect(toggleProvider([1, 2], 3, 2)).toEqual([1, 2]);
  });
});

describe("sameIds", () => {
  it("compares as sets", () => {
    expect(sameIds([1, 2], [2, 1])).toBe(true);
    expect(sameIds([1, 2], [1, 3])).toBe(false);
    expect(sameIds([1], [1, 2])).toBe(false);
  });
});
