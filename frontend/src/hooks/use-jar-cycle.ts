"use client";

import { useLayoutEffect, useState } from "react";

import type { Game } from "@/lib/api";
import { cycleIndex } from "@/lib/jar-cycle";

const TICK_MS = 250;

/**
 * The index of the note on show in a cycling jar (ADR-0018 amendment, part B). There are no tick
 * events: each snapshot carries the server's clock and the cycle anchor, and the screen works the
 * index out locally, so a phone opened mid-cycle is already on the right note. `paused` holds the
 * host's index. The offset between the server and this device is taken once per snapshot.
 */
export function useJarCycle(jar: Game["jar"] | null | undefined): {
  index: number;
  count: number;
  paused: boolean;
} {
  const cycle = jar?.cycle ?? null;
  const count = jar?.revealed.length ?? 0;
  const [index, setIndex] = useState(0);

  useLayoutEffect(() => {
    if (!cycle) return;
    const offsetMs = Date.parse(cycle.server_now) - Date.now();
    const anchor = Date.parse(cycle.anchor_at) / 1000;
    const compute = () =>
      cycleIndex(
        (Date.now() + offsetMs) / 1000,
        anchor,
        cycle.dwell_seconds,
        count,
        cycle.paused_index,
      );
    // Sync to the server's clock before paint, so a phone opened mid-cycle never flashes note 0.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads an external clock
    setIndex(compute());
    if (cycle.paused_index !== null) return;
    const timer = setInterval(() => setIndex(compute()), TICK_MS);
    return () => clearInterval(timer);
  }, [cycle, count]);

  return {
    index: cycle ? Math.min(index, Math.max(count - 1, 0)) : 0,
    count,
    paused: cycle?.paused_index != null,
  };
}
