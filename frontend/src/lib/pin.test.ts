import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { cleanPinInput, isCompletePin, KEYPAD, pinFailure, pressKey, wrongPinCopy } from "./pin";

describe("keypad", () => {
  it("lays out 1–9, Back, 0, Clear", () => {
    expect(KEYPAD).toHaveLength(12);
    expect(KEYPAD.filter((k) => /\d/.test(k))).toHaveLength(10);
  });

  it("appends digits up to six, Back drops one, Clear empties", () => {
    let pin = "";
    for (const key of ["1", "2", "3", "4", "5", "6", "7"] as const) pin = pressKey(pin, key);
    expect(pin).toBe("123456");
    expect(pressKey(pin, "back")).toBe("12345");
    expect(pressKey("", "back")).toBe("");
    expect(pressKey(pin, "clear")).toBe("");
  });

  it("cleans typed or pasted PINs", () => {
    expect(cleanPinInput(" 12-34 5678")).toBe("123456");
    expect(isCompletePin("123456")).toBe(true);
    expect(isCompletePin("12345")).toBe(false);
  });
});

describe("pinFailure", () => {
  it("reads tries left from a wrong PIN", () => {
    const error = new ApiError(403, "wrong_pin", "Wrong PIN.", null, null, 3);
    expect(pinFailure(error)).toEqual({ kind: "wrong", attemptsLeft: 3 });
  });

  it("treats 423 as locked", () => {
    expect(pinFailure(new ApiError(423, "pin_locked", "Locked", null, null, 0))).toEqual({
      kind: "locked",
    });
    expect(pinFailure(new ApiError(423, "http_error", "Locked"))).toEqual({ kind: "locked" });
  });

  it("treats 429 as the per-phone budget", () => {
    expect(pinFailure(new ApiError(429, "http_error", "Too many", null, 60))).toEqual({
      kind: "slow",
    });
  });

  it("leaves any other refusal as the server's message", () => {
    const error = new ApiError(403, "http_error", "This phone can't act as them");
    expect(pinFailure(error)).toEqual({ kind: "other", error });
    expect(pinFailure(new Error("boom")).kind).toBe("other");
  });
});

describe("wrongPinCopy", () => {
  it("shows tries left from the first miss, and warns on the last", () => {
    expect(wrongPinCopy(4, "Ana")).toBe("Not quite. 4 tries left.");
    expect(wrongPinCopy(1, "Ana")).toBe("Not quite. 1 try left before Ana gets locked.");
    expect(wrongPinCopy(null, "Ana")).toBe("Not quite. Try again.");
  });
});
