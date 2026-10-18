"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useLiveNight } from "@/hooks/use-phone";
import type { NightSummary } from "@/lib/api";
import { isNewNight, readSeenNight, withinNewWindow, writeSeenNight } from "@/lib/home";

/** Every mounted `useHouseholdNight` re-reads `fnh.seenNight` when one of them marks a night seen. */
const seenListeners = new Set<() => void>();

function subscribeSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => seenListeners.delete(listener);
}

/** Record `id` as shown in this tab and tell every mounted hook (drops the "Just started" chip). */
export function markNightSeen(id: string): void {
  writeSeenNight(id);
  for (const listener of seenListeners) listener();
}

/**
 * The household's live night, for every signed-in screen (guest-home §3.4, §6). The poll used to
 * live only on `/` and `/who`, so a phone on That's a wrap never learned a new night had started
 * (finding F1, the staging bug). `isNew` is true for a live night this tab hasn't shown yet, for 10
 * minutes after it was created; `markSeen()` records it (opening the night, tapping Go, auto-move).
 *
 * `enabled` is false until the phone is known to have a device (`GET /people` succeeded).
 */
export function useHouseholdNight(enabled = true): {
  night?: NightSummary;
  isNew: boolean;
  markSeen: () => void;
} {
  const live = useLiveNight(enabled);
  const night = live.data?.[0];
  const seen = useSyncExternalStore(subscribeSeen, readSeenNight, () => null);
  const isNew =
    night !== undefined &&
    isNewNight(seen, night.id) &&
    withinNewWindow(night.created_at, live.dataUpdatedAt);
  const nightId = night?.id;
  const markSeen = useCallback(() => {
    if (nightId) markNightSeen(nightId);
  }, [nightId]);
  return { night, isNew, markSeen };
}
