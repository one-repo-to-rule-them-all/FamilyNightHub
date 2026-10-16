"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { api, type ApiError, type Night } from "@/lib/api";

/** Seconds between snapshot polls while there is no live stream (04-frontend.md). */
export const POLL_MS = 5_000;

export type LiveState = "ready" | "reconnecting";

export const nightKey = (sessionId: string) => ["night", sessionId] as const;

/**
 * The night snapshot, kept fresh (04-frontend.md "State management", ADR-0004).
 *
 * Today this is the fallback half of the planned hook only: poll every 5s and refetch when the
 * tab becomes visible again, reporting `live: "reconnecting"` (rendered as `data-live`). The SSE
 * half (mint a ticket, open EventSource, invalidate on each event, `live: "ready"` while the
 * stream is up) replaces the polling here without changing callers or tests.
 */
export function useLiveSession(sessionId: string) {
  const query = useQuery<Night, ApiError>({
    queryKey: nightKey(sessionId),
    queryFn: () => api.night(sessionId),
    refetchInterval: POLL_MS,
    // Keep polling in a background tab too: a phone left on the ballot must see the reveal.
    refetchIntervalInBackground: true,
  });

  const { refetch } = query;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  const live: LiveState = "reconnecting";
  return { ...query, live };
}
