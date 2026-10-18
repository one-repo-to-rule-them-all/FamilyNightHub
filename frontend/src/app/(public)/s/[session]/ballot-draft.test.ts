// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ballotDraftKey,
  clearBallotDraft,
  draftDiffers,
  readBallotDraft,
  writeBallotDraft,
} from "./ballot-draft";

const ranks = [
  { option_id: "a", rank: 1 },
  { option_id: "b", rank: 2 },
];

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("ballot draft (guest-home S10: unsaved picks survive ‹ Home)", () => {
  it("round-trips per night and person", () => {
    writeBallotDraft("n1", "p1", ranks);
    expect(readBallotDraft("n1", "p1")).toEqual(ranks);
    expect(readBallotDraft("n1", "p2")).toBeNull();
    expect(readBallotDraft("n2", "p1")).toBeNull();
    expect(sessionStorage.getItem(ballotDraftKey("n1", "p1"))).not.toBeNull();
    clearBallotDraft("n1", "p1");
    expect(readBallotDraft("n1", "p1")).toBeNull();
  });

  it("ignores junk", () => {
    sessionStorage.setItem(ballotDraftKey("n1", "p1"), "{not json");
    expect(readBallotDraft("n1", "p1")).toBeNull();
    sessionStorage.setItem(ballotDraftKey("n1", "p1"), JSON.stringify({ a: 1 }));
    expect(readBallotDraft("n1", "p1")).toBeNull();
    sessionStorage.setItem(ballotDraftKey("n1", "p1"), JSON.stringify([{ option_id: 1 }, null]));
    expect(readBallotDraft("n1", "p1")).toBeNull();
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeBallotDraft("n1", "p1", ranks)).not.toThrow();
    expect(readBallotDraft("n1", "p1")).toBeNull();
    expect(() => clearBallotDraft("n1", "p1")).not.toThrow();
  });

  it("differs only when there is a draft with other picks", () => {
    expect(draftDiffers(null, ranks)).toBe(false);
    expect(draftDiffers([...ranks].reverse(), ranks)).toBe(false);
    expect(draftDiffers([{ option_id: "a", rank: 1 }], ranks)).toBe(true);
    expect(draftDiffers([], ranks)).toBe(true);
  });
});
