import { describe, expect, it } from "vitest";

import type { PersonTile } from "@/lib/api";

import { alsoOnPhone, memberSince, meStats, SHARED_LABEL } from "./me";

const tile = (id: string, extra: Partial<PersonTile> = {}): PersonTile => ({
  id,
  name: id,
  avatar_emoji: "🦊",
  color: "#3b82f6",
  is_guest: false,
  binding: "mine",
  has_pin: true,
  locked: false,
  current: false,
  can_rename: true,
  pin_reset: null,
  ...extra,
});

describe("memberSince", () => {
  it("says Family or Guest since the month and year", () => {
    const created_at = "2026-03-14T12:00:00Z";
    expect(memberSince({ is_guest: false, created_at }, "en-US")).toBe("Family since March 2026");
    expect(memberSince({ is_guest: true, created_at }, "en-US")).toBe("Guest since March 2026");
  });
});

describe("meStats", () => {
  const stats = {
    nights_joined: 12,
    ballots_cast: 11,
    winners_picked: 5,
    photos_uploaded: 21,
    ratings_given: 9,
    average_rating_given: 4.25,
  };
  it("is the 2×2: nights, winning picks, average, photos", () => {
    expect(meStats(stats)).toEqual([
      { label: "Movie nights", value: "12" },
      { label: "Winning picks", value: "5" },
      { label: "Average rating", value: "4.3 ★" },
      { label: "Photos", value: "21" },
    ]);
  });
  it("shows a dash before any rating", () => {
    expect(meStats({ ...stats, average_rating_given: null })[2].value).toBe("—");
  });
});

describe("alsoOnPhone", () => {
  it("is the others this phone holds, never the current person or someone elsewhere", () => {
    const people = [
      tile("lulu"),
      tile("me", { current: true }),
      tile("ava", { binding: "taken" }),
      tile("leo"),
    ];
    expect(alsoOnPhone(people).map((p) => p.id)).toEqual(["lulu", "leo"]);
  });
  it("is empty before people load", () => {
    expect(alsoOnPhone(undefined)).toEqual([]);
  });
  it("labels the line with the copy deck", () => {
    expect(SHARED_LABEL).toBe("Also on this phone:");
  });
});
