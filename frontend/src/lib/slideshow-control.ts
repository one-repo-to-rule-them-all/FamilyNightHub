/**
 * Who decides when the slideshow plays, and how a phone steps through it (issue #41,
 * 04-frontend.md "TV slideshow"). Pure; the schedule itself is slideshow.ts.
 *
 * The host's Start/Stop is server state on the night (`slideshow`, `slideshow_started_at`):
 * - `auto` (the default, the host never pressed anything): the TV plays once the night is
 *   `tonight`, as it did before the button existed. A forgotten button never strands the family
 *   on a blank TV.
 * - `playing`: the host pressed Start. Each press is a new `slideshow_started_at`, and the TV
 *   restarts from the newest photo.
 * - `stopped`: the host pressed Stop. The TV holds on "drop your photos" until Start.
 */
import type { Night } from "@/lib/api";

export type SlideshowMode = Night["slideshow"];

/** Does the TV play the album now (rather than holding on the drop prompt)? */
export function tvPlays(mode: SlideshowMode): boolean {
  return mode !== "stopped";
}

/** The TV's slideshow restarts whenever this changes: on every Start press. */
export function runKey(night: Pick<Night, "slideshow_started_at">): string {
  return night.slideshow_started_at ?? "auto";
}

/** The host's button: what pressing it would ask for. */
export function hostAction(mode: SlideshowMode): { playing: boolean; label: string } {
  return mode === "playing"
    ? { playing: false, label: "Stop the slideshow" }
    : { playing: true, label: "Start slideshow on the TV" };
}

/** The host's one-line status under the button. */
export function hostStatus(mode: SlideshowMode): string {
  if (mode === "playing") return "Playing on the TV.";
  if (mode === "stopped") return "The TV is holding on “drop your photos”.";
  return "The TV plays photos as they arrive. Start restarts it from the newest.";
}

/** A horizontal move shorter than this (px) is a tap, not a swipe. */
export const SWIPE_MIN_PX = 40;

/**
 * A touch that moved (dx, dy) px: +1 to step forward (swiped left), -1 back (swiped right),
 * 0 for a tap or a mostly vertical move (a scroll, or the system's own gestures).
 */
export function swipeStep(dx: number, dy: number): 1 | -1 | 0 {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}
