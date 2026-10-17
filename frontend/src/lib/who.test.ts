import { describe, expect, it } from "vitest";

import { statusHint } from "./who";

describe("statusHint", () => {
  it("tells a phone to vote once voting is open", () => {
    expect(statusHint("voting")).toBe("Voting is open: tap Vote now.");
  });
  it("says the movie is picked after the reveal", () => {
    expect(statusHint("revealed")).toBe("Tonight's movie is picked.");
    expect(statusHint("tonight")).toBe("Tonight's movie is picked.");
  });
  it("waits for the host otherwise", () => {
    expect(statusHint(undefined)).toBe("Waiting for the host to open voting.");
    expect(statusHint("draft")).toBe("Waiting for the host to open voting.");
  });
});
