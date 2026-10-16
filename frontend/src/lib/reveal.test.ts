import { describe, expect, it } from "vitest";

import { revealDuration, revealSequence } from "./reveal";

const options = ["a", "b", "c", "d"];

describe("revealSequence", () => {
  it("always lands on the stored winner, whichever it is", () => {
    for (const winner of options) {
      const frames = revealSequence(options, winner);
      expect(frames.at(-1)).toEqual({ optionId: winner, delayMs: 0 });
    }
  });

  it("walks the shortlist in order for the given laps before landing", () => {
    const frames = revealSequence(options, "c", { laps: 1 });
    expect(frames.map((f) => f.optionId)).toEqual(["a", "b", "c", "d", "a", "b", "c"]);
  });

  it("slows down: delays never decrease until the final hold", () => {
    const delays = revealSequence(options, "b").map((f) => f.delayMs);
    const moving = delays.slice(0, -1);
    for (let i = 1; i < moving.length; i++) expect(moving[i]).toBeGreaterThanOrEqual(moving[i - 1]);
    expect(moving[0]).toBe(70);
    expect(moving.at(-1)).toBeLessThanOrEqual(520);
  });

  it("is deterministic: every screen and every replay agrees", () => {
    expect(revealSequence(options, "d")).toEqual(revealSequence(options, "d"));
  });

  it("stays a short spin (seconds, not a wait)", () => {
    const total = revealDuration(revealSequence(["1", "2", "3", "4", "5", "6", "7", "8"], "8"));
    expect(total).toBeGreaterThan(1_000);
    expect(total).toBeLessThan(8_000);
  });

  it("reduced motion shows the winner straight away", () => {
    expect(revealSequence(options, "c", { reducedMotion: true })).toEqual([
      { optionId: "c", delayMs: 0 },
    ]);
  });

  it("an unknown winner gives no frames (the caller shows nothing to spin)", () => {
    expect(revealSequence(options, "zz")).toEqual([]);
    expect(revealSequence([], "a")).toEqual([]);
  });

  it("a one-title shortlist doesn't spin", () => {
    expect(revealSequence(["only"], "only")).toEqual([{ optionId: "only", delayMs: 0 }]);
  });
});
