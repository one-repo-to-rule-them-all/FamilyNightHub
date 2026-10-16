// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  forgetNightCode,
  nightCodeIsLive,
  recallNightCode,
  rememberNightCode,
} from "./night-code-handoff";

afterEach(() => window.sessionStorage.clear());

describe("night-code hand-off (sessionStorage, never the server)", () => {
  it("remembers per night and forgets on request", () => {
    rememberNightCode("night-1", "ABC234");
    rememberNightCode("night-2", "XYZ789");
    expect(recallNightCode("night-1")).toBe("ABC234");
    forgetNightCode("night-1");
    expect(recallNightCode("night-1")).toBeNull();
    expect(recallNightCode("night-2")).toBe("XYZ789");
  });

  it("uses sessionStorage only (tab-scoped), not localStorage", () => {
    rememberNightCode("night-1", "ABC234");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.getItem("fnh.nightCode.night-1")).toBe("ABC234");
  });

  it("a code is live until the night closes", () => {
    expect(["draft", "voting", "revealed", "tonight", "closed"].map(nightCodeIsLive)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
