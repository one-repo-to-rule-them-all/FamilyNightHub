"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type Night, type Voter } from "@/lib/api";

/**
 * The host and TV screens' view of a night, polled every 5s (04-frontend.md "State management").
 * SSE (`useLiveSession`, ADR-0004) replaces the interval later; until then the screens expose the
 * same `data-live` contract, so tests and the swap don't care which one is underneath:
 * `ready` after a good fetch, `reconnecting` while the last one failed.
 */
export const POLL_MS = 5_000;

export type LiveState = "connecting" | "ready" | "reconnecting";

export const nightKey = (sessionId: string) => ["night", sessionId] as const;
export const votersKey = (sessionId: string) => ["night", sessionId, "voters"] as const;

export function useNightPoll(sessionId: string) {
  const night = useQuery<Night, ApiError>({
    queryKey: nightKey(sessionId),
    queryFn: () => api.night(sessionId),
    refetchInterval: POLL_MS,
    // A TV is never "focused": keep polling while the tab is in the background too.
    refetchIntervalInBackground: true,
  });
  const live: LiveState = night.isError ? "reconnecting" : night.isSuccess ? "ready" : "connecting";
  return { night, live };
}

/** Who has voted (avatars only, never ranks), polled while voting is open. */
export function useVoters(sessionId: string, enabled: boolean) {
  return useQuery<Voter[], ApiError>({
    queryKey: votersKey(sessionId),
    queryFn: async () => (await api.voters(sessionId)).voted,
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    refetchIntervalInBackground: true,
  });
}
