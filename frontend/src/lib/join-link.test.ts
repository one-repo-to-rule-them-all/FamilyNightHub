import { describe, expect, it } from "vitest";

import { joinUrl, qrShape } from "./join-link";

describe("joinUrl", () => {
  it("builds the /j/{slug} door on the TV's origin", () => {
    expect(joinUrl("https://fnh.example", "baez-8k2")).toBe("https://fnh.example/j/baez-8k2");
    expect(joinUrl("http://localhost:3000/", "a b")).toBe("http://localhost:3000/j/a%20b");
  });
});

describe("qrShape", () => {
  it("draws one unit square per dark module, inside the symbol", () => {
    const { size, path } = qrShape("https://fnh.example/j/baez-8k2");
    expect(size).toBeGreaterThanOrEqual(21); // version 1 is 21×21
    const squares = path.match(/M(\d+) (\d+)h1v1h-1z/g) ?? [];
    expect(squares.length).toBeGreaterThan(0);
    for (const square of squares) {
      const [, x, y] = /M(\d+) (\d+)/.exec(square) ?? [];
      expect(Number(x)).toBeLessThan(size);
      expect(Number(y)).toBeLessThan(size);
    }
    // The three finder patterns' corners are always dark.
    expect(path).toContain("M0 0h1v1h-1z");
    expect(path).toContain(`M${size - 1} 0h1v1h-1z`);
    expect(path).toContain(`M0 ${size - 1}h1v1h-1z`);
  });
});
