import { describe, expect, it } from "vitest";

import { dropMark } from "./photo-drop";

describe("dropMark (one primary per screen)", () => {
  it("is the filled primary by default, as before", () => {
    expect(dropMark(false, true)).toEqual({
      label: "primary-action",
      tile: undefined,
      variant: "default",
    });
    expect(dropMark(true, true)).toEqual({
      label: "album-empty",
      tile: "primary-action",
      variant: "default",
    });
  });

  it("turns secondary and drops the primary mark when the screen's primary is elsewhere", () => {
    expect(dropMark(false, false)).toEqual({
      label: "add-photos",
      tile: undefined,
      variant: "secondary",
    });
    expect(dropMark(true, false)).toEqual({
      label: "album-empty",
      tile: "add-photos",
      variant: "secondary",
    });
  });
});
