import { describe, expect, it } from "vitest";

import {
  authorLine,
  canSendNote,
  clampCycleSeconds,
  jarProgress,
  kindName,
  jarStatusLine,
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
    expect(statusLabel("scattergories", "open")).toBe("Waiting to start");
    expect(statusLabel("scattergories", "live")).toBe("Playing");
    expect(statusLabel("scattergories", "ended")).toBe("Finished");
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
    const jar = { mode: "cycle", cycle: {}, note_count: 3, revealed_count: 3 };
    expect(jarStatusLine(jar, { index: 0, count: 3 })).toBe("3 notes cycling");
    expect(jarStatusLine(jar, { index: 0, count: 1 })).toBe("1 note cycling");
    expect(jarStatusLine({ ...jar, cycle: null }, { index: 0, count: 0 })).toBe("3 of 3 revealed");
    expect(jarStatusLine({ note_count: 2, revealed_count: 1 }, null)).toBe("1 of 2 revealed");
  });

  it("names the author, or nobody for an anonymous note", () => {
    expect(authorLine({ name: "Ava" })).toBe("— Ava");
    expect(authorLine(null)).toBe("— Someone in the family");
  });

  it("only offers the jar so far", () => {
    expect(PLAYABLE).toEqual(["gratitude_jar", "bingo", "scattergories"]);
    expect(KIND_COPY.gratitude_jar.name).toBe("Gratitude jar");
  });

  it("names a bingo round by its kind", () => {
    expect(kindName("bingo", "classic")).toBe("Classic bingo");
    expect(kindName("bingo", "thanksgiving")).toBe("Thanksgiving bingo");
    expect(kindName("bingo")).toBe("Thanksgiving bingo");
    expect(kindName("gratitude_jar", null)).toBe("Gratitude jar");
  });

  it("reads the seconds box as whole seconds from 5 to 60", () => {
    expect(clampCycleSeconds("12")).toBe(12);
    expect(clampCycleSeconds("1")).toBe(5);
    expect(clampCycleSeconds("999")).toBe(60);
    expect(clampCycleSeconds("")).toBe(12);
    expect(clampCycleSeconds("abc")).toBe(12);
  });
});
