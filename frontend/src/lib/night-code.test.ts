import { describe, expect, it } from "vitest";

import {
  cleanNightCodeInput,
  completeNightCode,
  lookalikes,
  NIGHT_CODE_ALPHABET,
} from "./night-code";

describe("cleanNightCodeInput", () => {
  it.each([
    ["abc234", "ABC234"],
    ["ABC-234", "ABC234"],
    [" a b c 2 3 4 ", "ABC234"],
    ["abc_234", "ABC234"],
    ["abc2345678", "ABC234"],
    ["ab😀c!2.3,4", "ABC234"],
    ["", ""],
  ])("%j -> %j", (raw, cleaned) => {
    expect(cleanNightCodeInput(raw)).toBe(cleaned);
  });

  it("keeps lookalikes so the hint can name them", () => {
    expect(cleanNightCodeInput("o0i1l2")).toBe("O0I1L2");
  });
});

describe("lookalikes", () => {
  it("is empty for a code in the TV alphabet", () => {
    expect(lookalikes("ABC234")).toEqual([]);
  });

  it("names each misread character once", () => {
    expect(lookalikes("OO1ABC")).toEqual(["O", "1"]);
  });

  it("matches the backend alphabet (app/domain/night_code.py)", () => {
    expect(NIGHT_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    for (const ch of "01OIL") expect(lookalikes(ch)).toEqual([ch]);
  });
});

describe("completeNightCode", () => {
  it("returns the canonical code once six valid characters are in", () => {
    expect(completeNightCode("abc-234")).toBe("ABC234");
  });

  it("is null while the code is short", () => {
    expect(completeNightCode("ABC23")).toBeNull();
  });

  it("is null when a character can never appear on the TV", () => {
    expect(completeNightCode("ABC23O")).toBeNull();
  });
});
