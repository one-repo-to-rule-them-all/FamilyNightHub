import { describe, expect, it } from "vitest";

import { codeFromQuery, joinUrl, qrShape, tvJoinUrl } from "./join-link";

describe("joinUrl", () => {
  it("builds the /j/{slug} door on the TV's origin", () => {
    expect(joinUrl("https://fnh.example", "baez-8k2")).toBe("https://fnh.example/j/baez-8k2");
    expect(joinUrl("http://localhost:3000/", "a b")).toBe("http://localhost:3000/j/a%20b");
  });
});

describe("tvJoinUrl (owner decision §10.1: code in the QR is opt-in)", () => {
  const origin = "https://fnh.example";

  it("is the plain door by default", () => {
    expect(tvJoinUrl(origin, "baez", "ABC234", false)).toBe("https://fnh.example/j/baez");
  });

  it("carries tonight's code only when the setting is on and the TV holds it", () => {
    expect(tvJoinUrl(origin, "baez", "abc 234", true)).toBe(
      "https://fnh.example/j/baez?code=ABC234",
    );
    expect(tvJoinUrl(origin, "baez", null, true)).toBe("https://fnh.example/j/baez");
    expect(tvJoinUrl(origin, "baez", "ABC1O0", true)).toBe("https://fnh.example/j/baez");
  });
});

describe("codeFromQuery", () => {
  it("reads a clean code from ?code=", () => {
    expect(codeFromQuery("?code=abc-234")).toBe("ABC234");
    expect(codeFromQuery(new URLSearchParams({ code: "ABC234" }))).toBe("ABC234");
  });

  it("drops a missing, short or look-alike code (AC-1.1b)", () => {
    expect(codeFromQuery("")).toBeNull();
    expect(codeFromQuery("?code=ABC")).toBeNull();
    expect(codeFromQuery("?code=ABC1O0")).toBeNull();
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
