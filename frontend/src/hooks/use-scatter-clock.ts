"use client";

import { useEffect, useMemo, useState } from "react";

import type { ScatterState } from "@/lib/api";
import { clockOffsetMs, secondsLeft, type RoundState } from "@/lib/scatter";

const TICK_MS = 250;

/**
 * The round's clock (ADR-0018 section 3): counts down locally against the server's `ends_at`,
 * using the offset between `server_now` and when the snapshot arrived. No tick comes over the
 * wire. `state` is the server's, tightened locally: a running round whose clock hit zero reads
 * as `closed` until the next snapshot says so.
 */
export function useScatterClock(scatter: ScatterState | undefined, receivedAtMs: number) {
  const offset = useMemo(
    () => (scatter ? clockOffsetMs(scatter.server_now, receivedAtMs) : 0),
    [scatter, receivedAtMs],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const round = scatter?.current ?? null;
  const seconds = round ? secondsLeft(round.ends_at, offset, now) : 0;
  const state: RoundState = !round
    ? "lobby"
    : round.state === "running" && seconds === 0
      ? "closed"
      : round.state;
  return { state, seconds, round };
}
