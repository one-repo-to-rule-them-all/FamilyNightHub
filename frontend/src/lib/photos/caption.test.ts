import { describe, expect, it } from "vitest";

import { photoAlt } from "@/lib/photos/caption";

describe("photoAlt", () => {
  it("uses the calendar date the photo was taken, without a time-zone shift", () => {
    const photo = {
      person_name: "Mia",
      taken_on: "2026-10-01",
      created_at: "2026-10-17T03:00:00Z",
    };
    expect(photoAlt(photo)).toBe("Photo from Mia, October 1, 2026");
  });

  it("falls back to when it was added", () => {
    const photo = { person_name: "Dad", taken_on: null, created_at: "2026-10-17T12:00:00Z" };
    expect(photoAlt(photo)).toMatch(/^Photo from Dad, October 1[67], 2026$/);
  });
});
