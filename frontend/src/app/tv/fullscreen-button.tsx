"use client";

import { Maximize } from "lucide-react";
import { useEffect, useState } from "react";

/** True when the page fills the screen: via the Fullscreen API, or the browser's own F11. */
function isFullscreen(): boolean {
  if (document.fullscreenElement) return true;
  return window.matchMedia?.("(display-mode: fullscreen)").matches ?? false;
}

/**
 * The TV's "Full screen" corner button (issue #90). Browsers only allow the Fullscreen API from a
 * click, so the TV can't do it by itself. If the browser refuses (or has no API), the hint to press
 * F11 stays. Hidden once the screen is full.
 */
export function FullscreenButton() {
  const [full, setFull] = useState(true); // nothing until mounted: no flash on a TV already full
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    const sync = () => setFull(isFullscreen());
    sync();
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("resize", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  if (full) return null;
  const supported = Boolean(
    document.fullscreenEnabled && document.documentElement.requestFullscreen,
  );

  return (
    <div
      className="tv-corner fixed top-[0.8em] right-[0.8em] z-20 flex items-center gap-[0.6em] text-[0.95em] text-muted-foreground"
      data-testid="tv-fullscreen"
    >
      {supported && !refused ? (
        <button
          type="button"
          className="flex items-center gap-[0.4em] rounded-full bg-card px-[0.9em] py-[0.4em] font-medium text-foreground ring-1 ring-foreground/15 hover:bg-muted"
          onClick={() => {
            try {
              document.documentElement.requestFullscreen()?.catch(() => setRefused(true));
            } catch {
              setRefused(true);
            }
          }}
        >
          <Maximize aria-hidden className="size-[1em]" />
          Full screen
        </button>
      ) : null}
      <span data-testid="tv-fullscreen-hint">
        {supported && !refused ? "or press F11" : "Press F11 for full screen"}
      </span>
    </div>
  );
}
