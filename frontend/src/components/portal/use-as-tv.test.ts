import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTvWindowTo, tvHref } from "./use-as-tv";

/** A stand-in for the blank window `window.open` returned. */
function fakeWindow({ closed = false } = {}) {
  const storage = new Map<string, string>();
  return {
    closed,
    location: { replace: vi.fn() },
    focus: vi.fn(),
    sessionStorage: {
      setItem: (k: string, v: string) => storage.set(k, v),
      getItem: (k: string) => storage.get(k) ?? null,
    },
    storage,
  };
}

function withThisTab(entries: Record<string, string>) {
  const storage = new Map(Object.entries(entries));
  vi.stubGlobal("window", {
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Open TV window (ADR-0002 amendment 2026-10-18)", () => {
  it("points the opened window at the night's TV screen and hands it the night code", () => {
    withThisTab({ "fnh.nightCode.n1": "ABC234" });
    const win = fakeWindow();
    expect(sendTvWindowTo(win as unknown as Window, "n1")).toBeNull();
    expect(win.location.replace).toHaveBeenCalledWith("/tv/n1");
    expect(win.focus).toHaveBeenCalled();
    expect(win.storage.get("fnh.nightCode.n1")).toBe("ABC234");
  });

  it("offers a plain link when the popup blocker ate the window", () => {
    withThisTab({});
    expect(sendTvWindowTo(null, "n1")).toBe("/tv/n1");
  });

  it("offers the link when the host closed the window while it paired", () => {
    withThisTab({});
    const win = fakeWindow({ closed: true });
    expect(sendTvWindowTo(win as unknown as Window, "n1")).toBe("/tv/n1");
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("never leaves the TV routes", () => {
    expect(tvHref("a/b")).toBe("/tv/a%2Fb");
  });
});
