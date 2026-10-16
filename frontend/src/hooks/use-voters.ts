"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type Voter } from "@/lib/api";
import { type LiveState, pollWhileDown } from "@/lib/live";

export const votersKey = (sessionId: string) => ["night", sessionId, "voters"] as const;

/**
 * Who has voted (avatars only, never ranks), while voting is open. Keyed under the night, so
 * every live event `useLiveSession` sees refreshes it too; it polls only while the stream is down.
 */
export function useVoters(sessionId: string, enabled: boolean, live: LiveState) {
  return useQuery<Voter[], ApiError>({
    queryKey: votersKey(sessionId),
    queryFn: async () => (await api.voters(sessionId)).voted,
    enabled,
    refetchInterval: enabled ? pollWhileDown(live) : false,
    refetchIntervalInBackground: true,
  });
}
