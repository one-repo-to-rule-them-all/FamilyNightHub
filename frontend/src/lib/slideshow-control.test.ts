import { describe, expect, it } from "vitest";

import {
  hostAction,
  hostStatus,
  runKey,
  SWIPE_MIN_PX,
  swipeStep,
  tvPlays,
} from "@/lib/slideshow-control";

describe("tvPlays", () => {
  it("plays unless the host stopped it", () => {
    expect(tvPlays("auto")).toBe(true);
    expect(tvPlays("playing")).toBe(true);
    expect(tvPlays("stopped")).toBe(false);
  });
});

describe("runKey", () => {
  it("changes with every Start and is stable in auto", () => {
    expect(runKey({ slideshow_started_at: null })).toBe("auto");
    expect(runKey({ slideshow_started_at: "2026-10-17T21:00:00Z" })).toBe("2026-10-17T21:00:00Z");
  });
});

describe("hostAction / hostStatus", () => {
  it("offers Stop while playing, Start otherwise", () => {
    expect(hostAction("playing")).toEqual({ playing: false, label: "Stop the slideshow" });
    expect(hostAction("auto")).toEqual({ playing: true, label: "Start slideshow on the TV" });
    expect(hostAction("stopped").playing).toBe(true);
  });

  it("says what the TV is doing", () => {
    expect(hostStatus("playing")).toMatch(/Playing/);
    expect(hostStatus("stopped")).toMatch(/holding/);
    expect(hostStatus("auto")).toMatch(/as they arrive/);
  });
});

describe("swipeStep", () => {
  it("steps forward on a left swipe and back on a right swipe", () => {
    expect(swipeStep(-SWIPE_MIN_PX, 0)).toBe(1);
    expect(swipeStep(SWIPE_MIN_PX + 20, 10)).toBe(-1);
  });

  it("treats short moves as taps", () => {
    expect(swipeStep(SWIPE_MIN_PX - 1, 0)).toBe(0);
    expect(swipeStep(0, 0)).toBe(0);
  });

  it("ignores mostly vertical moves", () => {
    expect(swipeStep(-60, 80)).toBe(0);
    expect(swipeStep(60, -60)).toBe(0);
  });
});
