import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AUTO_MOVE_SECONDS,
  holdAutoMove,
  isAutoMoveHeld,
  nextCountdown,
  subscribeAutoMove,
  uploadsInProgress,
  useAutoMoveHeld,
} from "./auto-move";

describe("the auto-move hold (§6)", () => {
  it("counts reasons and releases each once", () => {
    const listener = vi.fn();
    const off = subscribeAutoMove(listener);
    expect(isAutoMoveHeld()).toBe(false);
    const a = holdAutoMove();
    const b = holdAutoMove();
    expect(isAutoMoveHeld()).toBe(true);
    a();
    a(); // a second call is a no-op
    expect(isAutoMoveHeld()).toBe(true);
    b();
    expect(isAutoMoveHeld()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    off();
    holdAutoMove()();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("is never held on the server", () => {
    function Probe() {
      return createElement("span", null, String(useAutoMoveHeld()));
    }
    const release = holdAutoMove();
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>false</span>");
    release();
  });

  it("holds while a photo is processing, queued, uploading or waiting", () => {
    for (const state of ["processing", "queued", "uploading", "waiting"] as const) {
      expect(uploadsInProgress([{ state: "done" }, { state }])).toBe(true);
    }
    expect(uploadsInProgress([{ state: "done" }, { state: "failed" }])).toBe(false);
    expect(uploadsInProgress([])).toBe(false);
  });
});

describe("nextCountdown (§5 H0c)", () => {
  it("starts at 60 and takes a second off per tick", () => {
    expect(AUTO_MOVE_SECONDS).toBe(60);
    expect(nextCountdown({ seconds: 60, paused: false }, { held: false, tick: true })).toEqual({
      seconds: 59,
      paused: false,
    });
  });

  it("holds the number while held and resumes from it", () => {
    const paused = nextCountdown({ seconds: 50, paused: false }, { held: true, tick: true });
    expect(paused).toEqual({ seconds: 50, paused: true });
    expect(nextCountdown(paused, { held: false, tick: false })).toEqual({
      seconds: 50,
      paused: false,
    });
    expect(nextCountdown(paused, { held: false, tick: true })).toEqual({
      seconds: 49,
      paused: false,
    });
  });

  it("never goes below 0", () => {
    const end = nextCountdown({ seconds: 0, paused: false }, { held: false, tick: true });
    expect(end.seconds).toBe(0);
  });
});
