"use client";

import { useEffect } from "react";

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };
type WakeLockLike = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

/**
 * Keeps the TV's screen on with the Screen Wake Lock API where the browser has it (04-frontend.md).
 * The lock is released whenever the tab is hidden (the browser would drop it anyway) and
 * re-requested on every return to visible. Unsupported browsers and refusals (low battery, policy) are silently ignored: the screen
 * still works, it just may dim.
 */
export function useWakeLock(active = true): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;

    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await wakeLock.request("screen");
        if (disposed) await next.release();
        else sentinel = next;
      } catch {
        // NotAllowedError and friends: nothing to do.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        // Let go as soon as the tab is hidden rather than waiting on the browser to.
        void sentinel?.release().catch(() => undefined);
        sentinel = null;
      } else if (!sentinel || sentinel.released) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
