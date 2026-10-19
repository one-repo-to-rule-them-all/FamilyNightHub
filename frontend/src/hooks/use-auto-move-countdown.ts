"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { markNightSeen } from "@/hooks/use-household-night";
import { AUTO_MOVE_SECONDS, isAutoMoveHeld, nextCountdown, useAutoMoveHeld } from "@/lib/auto-move";
import { nightHref, readStayNight, writeStayNight } from "@/lib/home";

/** Something on screen the guest is in the middle of: an upload, any native dialog, or a hidden tab. */
function somethingHolds(): boolean {
  return (
    isAutoMoveHeld() ||
    document.querySelector("dialog[open]") !== null ||
    document.visibilityState === "hidden"
  );
}

/**
 * The running countdown, kept outside React (guest-home §5 H0c). Every signed-in page mounts its
 * own `GuestShell`, so the toast remounts on each navigation. Keeping the seconds here means the
 * countdown carries on from the same second across Home, History, Me and the past nights instead
 * of starting over at 60. A full page load starts again (the module is fresh).
 */
type Run = { nightId: string; seconds: number; paused: boolean };

let run: Run | null = null;
const runListeners = new Set<() => void>();

function setRun(next: Run | null): void {
  run = next;
  for (const listener of runListeners) listener();
}

function subscribeRun(listener: () => void): () => void {
  runListeners.add(listener);
  return () => runListeners.delete(listener);
}

const readRun = () => run;

/** The night a countdown is running (or paused) for in this page load, else null. */
export function runningCountdownFor(): string | null {
  return run?.nightId ?? null;
}

/** For tests: forget the running countdown, as a fresh page load would. */
export function resetCountdownForTests(): void {
  setRun(null);
}

/**
 * The 60 s auto-move behind the new-night toast (guest-home §3.3 rule 3, §5 H0c). Ticks once a
 * second from 60; pauses (holding the number) while an upload holds it, a `<dialog>` is open or the
 * page is hidden, and resumes from the same second; at 0 it records the night as seen and
 * `router.push`es to it, so Back returns to where the phone was. The seconds survive navigation
 * (see `Run`); a new `nightId` starts again at 60.
 *
 * `enabled` starts a countdown; once one runs it carries on wherever the hook is mounted until
 * `join()` (records the night as seen and goes there at once), `stay()` (cancels it for that night
 * in this tab, `fnh.stayNight`), the move at 0, or `cancel()` (the phone reached the night by
 * itself).
 */
export function useAutoMoveCountdown(
  nightId: string | undefined,
  enabled: boolean,
): {
  seconds: number;
  paused: boolean;
  join: () => void;
  stay: () => void;
  cancel: () => void;
  stayed: boolean;
  /** A countdown for this night is under way in this page load (the toast stays up for it). */
  counting: boolean;
} {
  const router = useRouter();
  const held = useAutoMoveHeld();
  const current = useSyncExternalStore(subscribeRun, readRun, () => null);
  const [stayedFor, setStayedFor] = useState<string | null>(null);

  const stayed = nightId !== undefined && (stayedFor === nightId || readStayNight() === nightId);
  const mine = current !== null && current.nightId === nightId ? current : null;
  // A countdown already under way keeps going on the next screen even if `enabled` is false there.
  const running = nightId !== undefined && !stayed && (enabled || mine !== null);

  // Claim the countdown for this night (a different night, or none yet, starts at 60).
  useEffect(() => {
    if (running && nightId && run?.nightId !== nightId) {
      setRun({ nightId, seconds: AUTO_MOVE_SECONDS, paused: false });
    }
  }, [running, nightId]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (!run || run.nightId !== nightId) return;
      setRun({
        nightId: run.nightId,
        ...nextCountdown(run, { held: somethingHolds(), tick: true }),
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [running, nightId]);

  const go = useCallback(
    (id: string) => {
      markNightSeen(id);
      if (run?.nightId === id) setRun(null);
      router.push(nightHref(id));
    },
    [router],
  );

  const moved = useRef<string | null>(null);
  const due = running && mine !== null && mine.seconds === 0;
  useEffect(() => {
    if (!due || !nightId || moved.current === nightId) return;
    moved.current = nightId;
    go(nightId);
  }, [due, nightId, go]);

  const join = useCallback(() => {
    if (nightId) go(nightId);
  }, [nightId, go]);

  const stay = useCallback(() => {
    if (!nightId) return;
    writeStayNight(nightId);
    setStayedFor(nightId);
    if (run?.nightId === nightId) setRun(null);
  }, [nightId]);

  const cancel = useCallback(() => {
    if (nightId && run?.nightId === nightId) setRun(null);
  }, [nightId]);

  return {
    cancel,
    seconds: mine?.seconds ?? AUTO_MOVE_SECONDS,
    paused: running && ((mine?.paused ?? false) || held),
    join,
    stay,
    stayed,
    counting: mine !== null,
  };
}
