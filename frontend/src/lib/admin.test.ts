import { describe, expect, it } from "vitest";

import {
  AGE_CAPS,
  PEOPLE_FILTERS,
  PERSON_STATUS_LABEL,
  RESET_PIN_NOTE,
  MAX_STREAMING_PROVIDERS,
  PERSON_COLORS,
  ageCapFromSelect,
  cleanName,
  colorChoices,
  describeMerge,
  filterPeople,
  deviceName,
  lastSeen,
  attentionLine,
  needsAttention,
  normalizeRegion,
  peopleSummary,
  personChanges,
  personIdFromHash,
  personStatus,
  resetPinEmphasis,
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

const person = (over: Partial<{ is_guest: boolean; has_pin: boolean; locked: boolean }> = {}) => ({
  is_guest: false,
  has_pin: true,
  locked: false,
  ...over,
});

describe("personStatus", () => {
  it("puts a lock first, then whether a PIN is set", () => {
    expect(personStatus(person({ locked: true }))).toBe("locked");
    expect(personStatus(person({ locked: true, has_pin: false }))).toBe("locked");
    expect(personStatus(person({ has_pin: false }))).toBe("no-pin");
    expect(personStatus(person())).toBe("pin-set");
    expect(PERSON_STATUS_LABEL[personStatus(person({ has_pin: false }))]).toBe("No PIN yet");
  });

  it("needs attention when locked or without a PIN", () => {
    expect(needsAttention(person({ locked: true }))).toBe(true);
    expect(needsAttention(person({ has_pin: false }))).toBe(true);
    expect(needsAttention(person())).toBe(false);
  });
});

describe("filterPeople", () => {
  const family = { id: "f", ...person() };
  const guest = { id: "g", ...person({ is_guest: true, has_pin: false }) };
  const locked = { id: "l", ...person({ locked: true }) };
  const all = [family, guest, locked];

  it("filters by kind and by attention", () => {
    expect(filterPeople(all, "all")).toEqual(all);
    expect(filterPeople(all, "family")).toEqual([family, locked]);
    expect(filterPeople(all, "guests")).toEqual([guest]);
    expect(filterPeople(all, "attention")).toEqual([guest, locked]);
    expect(PEOPLE_FILTERS.map((f) => f.key)).toEqual(["all", "family", "guests", "attention"]);
  });
});

describe("attentionLine", () => {
  const named = (name: string, overrides: Parameters<typeof person>[0] = {}) => ({
    name,
    ...person(overrides),
  });

  it("is null when everyone has a PIN", () => {
    expect(attentionLine([named("Ava"), named("Leo")])).toBeNull();
    expect(attentionLine([])).toBeNull();
  });

  // Staging 2026-10-17: two pre-PIN people made People read "Needs attention · 2" while the
  // inbox and the nav badge (correctly) showed nothing. The line names who and why.
  it("explains no-PIN people, who are never an inbox row", () => {
    expect(
      attentionLine([named("Ava", { has_pin: false }), named("Leo", { has_pin: false })]),
    ).toBe(
      "Ava and Leo haven't set a PIN yet. Nothing to do here: they choose one on their phone " +
        "the next time they pick their name.",
    );
    expect(attentionLine([named("Ava", { has_pin: false })])).toMatch(/^Ava hasn't set a PIN/);
  });

  it("explains locked people, and counts long lists", () => {
    expect(attentionLine([named("Mia", { locked: true })])).toBe(
      "Mia is locked after 5 wrong PINs. Tap Reset PIN on their row, and they choose a new one " +
        "on their phone.",
    );
    const many = ["A", "B", "C", "D"].map((n) => named(n, { locked: true, has_pin: false }));
    expect(attentionLine(many)).toMatch(/^4 people are locked/);
    expect(
      attentionLine([named("Ava", { has_pin: false }), named("Mia", { locked: true })]),
    ).toMatch(/^Ava hasn't set a PIN yet\..* Mia is locked/);
  });
});

describe("peopleSummary", () => {
  it("counts people, family and guests", () => {
    expect(peopleSummary([person(), person(), person({ is_guest: true })])).toBe(
      "3 people · 2 family, 1 guest",
    );
    expect(peopleSummary([person()])).toBe("1 person · 1 family, 0 guests");
  });
});

describe("personIdFromHash", () => {
  it("reads #person-{id}", () => {
    expect(personIdFromHash("#person-abc-123")).toBe("abc-123");
    expect(personIdFromHash("#pin-requests")).toBe(null);
    expect(personIdFromHash("")).toBe(null);
  });
});

describe("reset PIN (#88)", () => {
  it("is prominent for a lock, quiet for a set PIN, absent before a PIN exists", () => {
    expect(resetPinEmphasis(person({ locked: true }))).toBe("prominent");
    expect(resetPinEmphasis(person({ locked: true, has_pin: false }))).toBe("prominent");
    expect(resetPinEmphasis(person())).toBe("quiet");
    expect(resetPinEmphasis(person({ has_pin: false }))).toBeNull();
  });

  it("tells the admin who picks the new PIN", () => {
    expect(RESET_PIN_NOTE).toBe("They'll choose a new one on their phone.");
  });
});
