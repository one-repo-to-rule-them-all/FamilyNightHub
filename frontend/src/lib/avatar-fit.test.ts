import { describe, expect, it } from "vitest";

import {
  fitAvatars,
  HERE_STRIP_COMPACT_STEPS,
  HERE_STRIP_STEPS,
  TV_TURNOUT_STEPS,
} from "./avatar-fit";

const steps = [
  { upTo: 3, size: "big" },
  { upTo: 6, size: "small" },
];

describe("fitAvatars", () => {
  it("keeps the biggest size while it fits", () => {
    expect(fitAvatars(0, steps)).toEqual({ size: "big", shown: 0, more: 0 });
    expect(fitAvatars(3, steps)).toEqual({ size: "big", shown: 3, more: 0 });
  });

  it("steps down once a size is full", () => {
    expect(fitAvatars(4, steps)).toEqual({ size: "small", shown: 4, more: 0 });
    expect(fitAvatars(6, steps)).toEqual({ size: "small", shown: 6, more: 0 });
  });

  it("folds the rest into +N past the last step, the +N taking one slot", () => {
    expect(fitAvatars(7, steps)).toEqual({ size: "small", shown: 5, more: 2 });
    expect(fitAvatars(40, steps)).toEqual({ size: "small", shown: 5, more: 35 });
  });

  it("never draws more than the last step holds", () => {
    for (let n = 0; n <= 60; n++) {
      const fit = fitAvatars(n, steps);
      expect(fit.shown + (fit.more > 0 ? 1 : 0)).toBeLessThanOrEqual(6);
      expect(fit.shown + fit.more).toBe(n);
    }
  });

  it("treats junk counts as zero", () => {
    expect(fitAvatars(-2, steps)).toEqual({ size: "big", shown: 0, more: 0 });
  });

  it("needs a step", () => {
    expect(() => fitAvatars(1, [])).toThrow();
  });
});

describe("screen steps", () => {
  it("TV turnout: twenty people shrink but all show", () => {
    expect(fitAvatars(4, TV_TURNOUT_STEPS)).toMatchObject({ size: "xl", more: 0 });
    expect(fitAvatars(20, TV_TURNOUT_STEPS)).toEqual({ size: "md", shown: 20, more: 0 });
    expect(fitAvatars(31, TV_TURNOUT_STEPS)).toEqual({ size: "sm", shown: 29, more: 2 });
  });

  it("Here tonight: steps down, then +N past twenty", () => {
    expect(fitAvatars(6, HERE_STRIP_STEPS).size).toBe("lg");
    expect(fitAvatars(7, HERE_STRIP_STEPS).size).toBe("md");
    expect(fitAvatars(20, HERE_STRIP_STEPS)).toEqual({ size: "sm", shown: 20, more: 0 });
    expect(fitAvatars(22, HERE_STRIP_STEPS)).toEqual({ size: "sm", shown: 19, more: 3 });
  });

  it("compact strip: one short row", () => {
    expect(fitAvatars(5, HERE_STRIP_COMPACT_STEPS).size).toBe("sm");
    expect(fitAvatars(8, HERE_STRIP_COMPACT_STEPS)).toEqual({ size: "xs", shown: 8, more: 0 });
    expect(fitAvatars(20, HERE_STRIP_COMPACT_STEPS)).toEqual({ size: "xs", shown: 7, more: 13 });
  });

  it("steps are ordered", () => {
    for (const s of [TV_TURNOUT_STEPS, HERE_STRIP_STEPS, HERE_STRIP_COMPACT_STEPS]) {
      const ups = s.map((x) => x.upTo);
      expect([...ups].sort((a, b) => a - b)).toEqual(ups);
    }
  });
});
