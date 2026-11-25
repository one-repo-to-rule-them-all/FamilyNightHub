import { useQuery } from "@tanstack/react-query";

import { POLL_MS } from "@/hooks/use-live-session";
import { api, type ApiError } from "@/lib/api";

/**
 * The game a host sent to the paired TV (ADR-0018 amendment "The TV follows the host"), or
 * null. A snapshot the TV polls: the server drops it when the game ends or the host presses
 * "Back to QR", so a missed update corrects itself on the next read.
 */
export function useTvTarget(options: { enabled?: boolean } = {}) {
  return useQuery<string | null, ApiError>({
    queryKey: ["tv-target"],
    queryFn: async () => (await api.tvTarget()).game_id,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    enabled: options.enabled ?? true,
  });
}
