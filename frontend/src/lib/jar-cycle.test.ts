import { describe, expect, it } from "vitest";

import { cycleCounter, cycleIndex } from "./jar-cycle";
import vectors from "./jar-cycle.vectors.json";

describe("cycleIndex", () => {
  it.each(vectors.cases)("matches the shared vector %#", (c) => {
    expect(cycleIndex(c.now, c.anchor, c.dwell, c.count, c.paused)).toBe(c.expected);
  });
});

describe("cycleCounter", () => {
  it("is one-based and empty with no notes", () => {
    expect(cycleCounter(3, 17)).toBe("Note 4 of 17");
    expect(cycleCounter(0, 0)).toBe("");
  });
});
