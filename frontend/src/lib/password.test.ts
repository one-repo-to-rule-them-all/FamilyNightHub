import { describe, expect, it } from "vitest";

import { linkSpent, passwordProblem } from "./password";

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

describe("linkSpent", () => {
  // E2E 2026-10-17: the callback waited for a 401 the API never sends, so a used link kept
  // offering "Save and sign in" and never "Send a new link".
  it("treats the API's 400 (and a 401) as a dead link", () => {
    expect(linkSpent(400)).toBe(true);
    expect(linkSpent(401)).toBe(true);
  });

  it("lets a weak password (422) or no answer try again", () => {
    expect(linkSpent(422)).toBe(false);
    expect(linkSpent(undefined)).toBe(false);
  });
});
