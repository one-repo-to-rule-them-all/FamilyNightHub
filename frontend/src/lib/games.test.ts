import { describe, expect, it } from "vitest";

import {
  authorLine,
  canSendNote,
  jarProgress,
  KIND_COPY,
  NOTE_MAX,
  noteCounter,
  PLAYABLE,
  statusLabel,
} from "./games";

describe("games", () => {
  it("labels the jar's states and the other kinds'", () => {
    expect(statusLabel("gratitude_jar", "open")).toBe("Collecting notes");
    expect(statusLabel("gratitude_jar", "live")).toBe("Revealing");
    expect(statusLabel("gratitude_jar", "ended")).toBe("Finished");
    expect(statusLabel("bingo", "live")).toBe("Live");
    expect(statusLabel("bingo", "open")).toBe("Open");
    expect(statusLabel("bingo", "ended")).toBe("Finished");
  });

  it("counts characters and flags a note over the limit", () => {
    expect(noteCounter("  hi ")).toEqual({ text: `2 / ${NOTE_MAX}`, over: false });
    expect(noteCounter("x".repeat(NOTE_MAX + 1)).over).toBe(true);
    expect(canSendNote("   ")).toBe(false);
    expect(canSendNote("thanks")).toBe(true);
    expect(canSendNote("x".repeat(NOTE_MAX + 1))).toBe(false);
  });

  it("describes jar progress", () => {
    expect(jarProgress(0, 0)).toBe("No notes yet");
    expect(jarProgress(1, 0)).toBe("1 note in the jar");
    expect(jarProgress(3, 0)).toBe("3 notes in the jar");
    expect(jarProgress(3, 2)).toBe("2 of 3 revealed");
  });

  it("names the author, or nobody for an anonymous note", () => {
    expect(authorLine({ name: "Ava" })).toBe("— Ava");
    expect(authorLine(null)).toBe("— Someone in the family");
  });

  it("only offers the jar so far", () => {
    expect(PLAYABLE).toEqual(["gratitude_jar", "bingo"]);
    expect(KIND_COPY.gratitude_jar.name).toBe("Gratitude jar");
  });
});
