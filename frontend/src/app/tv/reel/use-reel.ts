"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type ApiError } from "@/lib/api";
import { REEL_POLL_MS, type ReelData, type ReelWindow, reelIndex } from "@/lib/reel";

const TICK_MS = 500;

/**
 * The night reel's snapshot and the index of the slide on show. No tick events: the server sent
 * the show order, an anchor and a dwell, and this device works the index out from its own clock
 * (offset by the server's clock, taken when the snapshot arrived). The snapshot is refetched every
 * 30 s and when the tab comes back, so a new winner or quote joins the show.
 */
export function useReel(window: ReelWindow) {
  const query = useQuery<ReelData, ApiError>({
    queryKey: ["reel", window],
    queryFn: () => api.reel(window),
    refetchInterval: REEL_POLL_MS,
    refetchIntervalInBackground: true,
  });
  const reel = query.data ?? null;
  const fetchedAt = query.dataUpdatedAt;
  const count = reel?.items.length ?? 0;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!reel) return;
    const compute = () => reelIndex(Date.now(), reel, fetchedAt, count);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads an external clock
    setIndex(compute());
    if (count < 2) return;
    const timer = setInterval(() => setIndex(compute()), TICK_MS);
    return () => clearInterval(timer);
  }, [reel, fetchedAt, count]);

  const { refetch } = query;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  return { ...query, reel, index: Math.min(index, Math.max(count - 1, 0)), count };
}
