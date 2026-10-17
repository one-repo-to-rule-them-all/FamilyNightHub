import { describe, expect, it } from "vitest";

import { tvHelpName } from "./tv-help";

describe("tvHelpName", () => {
  it("names the oldest waiting claim", () => {
    expect(tvHelpName({ count: 2, first_name: "RooDog" })).toBe("RooDog");
  });

  it("shows nothing while nobody is waiting", () => {
    expect(tvHelpName({ count: 0, first_name: null })).toBeNull();
    expect(tvHelpName(null)).toBeNull();
    expect(tvHelpName(undefined)).toBeNull();
  });

  it("still nudges when the claim has no name", () => {
    expect(tvHelpName({ count: 1, first_name: null })).toBe("Someone");
    expect(tvHelpName({ count: 1, first_name: "  " })).toBe("Someone");
  });
});
