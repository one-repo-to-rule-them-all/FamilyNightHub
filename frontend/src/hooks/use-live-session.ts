"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type ApiError, liveStreamUrl, type Night } from "@/lib/api";
import { LiveConnection, type LiveState, nightPollInterval, POLL_MS } from "@/lib/live";

export { type LiveState, POLL_MS };

export const nightKey = (sessionId: string) => ["night", sessionId] as const;

/**
 * The night snapshot, kept fresh (04-frontend.md "State management", ADR-0004).
 *
 * Mints an SSE ticket and opens the night's stream (`LiveConnection`). Every event, and every
 * (re)open, invalidates `["night", id]`, which by prefix also refreshes anything keyed under it
 * (the voters list). The snapshot is the only source of truth: events are never read. While the
 * stream is down (or the night is `revealed`) the snapshot polls every 5s, and it refetches
 * when the tab becomes visible.
 * `live` is `ready` while the stream is open, else `reconnecting`; screens render it as
 * `data-live`, which the e2e specs wait on.
 */
export function useLiveSession(sessionId: string) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveState>("reconnecting");

  const query = useQuery<Night, ApiError>({
    queryKey: nightKey(sessionId),
    queryFn: () => api.night(sessionId),
    // Also while `revealed`: the lazy settle into `tonight` sends no event (see live.ts).
    refetchInterval: (query) => nightPollInterval(live, query.state.data?.status),
    // Keep polling in a background tab too: a phone left on the ballot must see the reveal.
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: nightKey(sessionId) });
    // No EventSource (very old browser): stay `reconnecting` and keep polling.
    const connection =
      typeof EventSource === "undefined"
        ? null
        : new LiveConnection({
            mintTicket: async () => (await api.sseTicket(sessionId)).ticket,
            openStream: (ticket) => new EventSource(liveStreamUrl(sessionId, ticket)),
            onHint: refresh,
            onState: setLive,
          });
    connection?.start();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      connection?.wake();
    };
    const onOnline = () => connection?.wake();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      connection?.stop();
      setLive("reconnecting");
    };
  }, [queryClient, sessionId]);

  return { ...query, live };
}
