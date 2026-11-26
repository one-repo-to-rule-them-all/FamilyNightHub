import { useQuery } from "@tanstack/react-query";

import { POLL_MS } from "@/hooks/use-live-session";
import { api, type ApiError, type Schemas } from "@/lib/api";

export type TvTargetState = Schemas["TvTargetOut"];

/**
 * The game a host sent to the paired TV (ADR-0018 amendment "The TV follows the host"), or
 * null. A snapshot the TV polls: the server drops it when the game ends or the host presses
 * "Back to QR", so a missed update corrects itself on the next read.
 */
export function useTvTarget(options: { enabled?: boolean } = {}) {
  return useQuery<TvTargetState, ApiError, string | null>({
    queryKey: ["tv-target"],
    queryFn: () => api.tvTarget(),
    select: (t) => t.game_id,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    enabled: options.enabled ?? true,
  });
}

/** The whole snapshot, with the ended sent game the TV holds for a while (tv-hold.ts). */
export function useTvTargetState() {
  return useQuery<TvTargetState, ApiError>({
    queryKey: ["tv-target"],
    queryFn: () => api.tvTarget(),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
}
