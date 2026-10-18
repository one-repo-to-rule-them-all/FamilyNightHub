/**
 * The auto-move hold and countdown arithmetic (proposals/guest-home.md §5 H0c, §6).
 *
 * That's a wrap and the recap move the phone to a newly started night after 60 s. Anything that
 * must not be interrupted holds that countdown: `holdAutoMove()` adds a reason and returns its
 * release. The upload queue holds it while a photo is processing or uploading; open `<dialog>`s
 * and a hidden page are checked by the countdown hook itself on every tick.
 */
import { useSyncExternalStore } from "react";

import type { JobState } from "@/lib/photos/queue";

export const AUTO_MOVE_SECONDS = 60;

let holds = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Pause every countdown until the returned release runs (calling it twice releases once). */
export function holdAutoMove(): () => void {
  holds += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    notify();
  };
}

export function isAutoMoveHeld(): boolean {
  return holds > 0;
}

export function subscribeAutoMove(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether something holds the countdown right now (false on the server). */
export function useAutoMoveHeld(): boolean {
  return useSyncExternalStore(subscribeAutoMove, isAutoMoveHeld, () => false);
}

/** Upload-queue states that hold the countdown: a photo on its way (§5 H0c pause rule 1). */
const UPLOADING: readonly JobState[] = ["processing", "queued", "uploading", "waiting"];

export function uploadsInProgress(jobs: readonly { state: JobState }[]): boolean {
  return jobs.some((job) => UPLOADING.includes(job.state));
}

export type Countdown = { seconds: number; paused: boolean };

/** One step of the countdown: a tick takes a second off unless something holds it. Never below 0. */
export function nextCountdown(
  state: Countdown,
  input: { held: boolean; tick: boolean },
): Countdown {
  if (input.held) return { seconds: state.seconds, paused: true };
  if (!input.tick) return { seconds: state.seconds, paused: false };
  return { seconds: Math.max(0, state.seconds - 1), paused: false };
}
