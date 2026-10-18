"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * The 60 s auto-move on That's a wrap and the recap (guest-home §3.3 rule 3, §5 H0c, owner decision
 * §11.2). Ticks once a second from 60; pauses (holding the number) while an upload holds it, a
 * `<dialog>` is open or the page is hidden, and resumes from the same second; at 0 it records the
 * night as seen and `router.push`es to it, so Back returns here. A new `nightId` starts again at 60.
 * `stay()` cancels it for that night in this tab (`fnh.stayNight`).
 */
export function useAutoMoveCountdown(
  nightId: string | undefined,
  enabled: boolean,
): { seconds: number; paused: boolean; stay: () => void; stayed: boolean } {
  const router = useRouter();
  const held = useAutoMoveHeld();
  const [state, setState] = useState({ nightId, seconds: AUTO_MOVE_SECONDS, paused: false });
  const [stayedFor, setStayedFor] = useState<string | null>(null);
  if (state.nightId !== nightId) {
    // Two nights back to back: the hand-off now points at another night, so start over.
    setState({ nightId, seconds: AUTO_MOVE_SECONDS, paused: false });
  }

  const stayed = nightId !== undefined && (stayedFor === nightId || readStayNight() === nightId);
  const running = enabled && nightId !== undefined && !stayed;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const hold = somethingHolds();
      setState((s) =>
        s.nightId === nightId ? { nightId, ...nextCountdown(s, { held: hold, tick: true }) } : s,
      );
    }, 1_000);
    return () => clearInterval(timer);
  }, [running, nightId]);

  const moved = useRef<string | null>(null);
  const due = running && state.nightId === nightId && state.seconds === 0;
  useEffect(() => {
    if (!due || !nightId || moved.current === nightId) return;
    moved.current = nightId;
    markNightSeen(nightId);
    router.push(nightHref(nightId));
  }, [due, nightId, router]);

  const stay = useCallback(() => {
    if (!nightId) return;
    writeStayNight(nightId);
    setStayedFor(nightId);
  }, [nightId]);

  return { seconds: state.seconds, paused: running && (state.paused || held), stay, stayed };
}
