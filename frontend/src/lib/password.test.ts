import { describe, expect, it } from "vitest";

import { passwordProblem } from "./password";

describe("passwordProblem", () => {
  it("accepts a long passphrase that matches", () => {
    expect(passwordProblem("popcorn on the couch", "popcorn on the couch")).toBeNull();
  });

  it("rejects short, overlong, single-character and mismatched passwords", () => {
    expect(passwordProblem("short", "short")).toMatch(/at least 12/);
    expect(passwordProblem("x".repeat(257), "x".repeat(257))).toMatch(/at most 256/);
    expect(passwordProblem("aaaaaaaaaaaa", "aaaaaaaaaaaa")).toMatch(/repeated/);
    expect(passwordProblem("popcorn on the couch", "popcorn on the sofa")).toMatch(/match/);
  });
});
