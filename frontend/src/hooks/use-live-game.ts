"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type ApiError, type Game, gameStreamUrl } from "@/lib/api";
import { LiveConnection, type LiveState, pollWhileDown } from "@/lib/live";

export const gameKey = (gameId: string) => ["game", gameId] as const;

/**
 * A game's snapshot, kept fresh over its own SSE channel (ADR-0018, the twin of
 * `useLiveSession`): same ticket, backoff and "events are hints" contract. Every event or
 * (re)open invalidates `["game", id]` and anything under it (the phone's own notes, the host's
 * moderation list). Polls every 5s only while the stream is down. `live` renders as `data-live`
 * for the e2e specs.
 */
export function useLiveGame(gameId: string) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveState>("reconnecting");

  const query = useQuery<Game, ApiError>({
    queryKey: gameKey(gameId),
    queryFn: () => api.game(gameId),
    refetchInterval: () => pollWhileDown(live),
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: gameKey(gameId) });
    const connection =
      typeof EventSource === "undefined"
        ? null
        : new LiveConnection({
            mintTicket: async () => (await api.sseGameTicket(gameId)).ticket,
            openStream: (ticket) => new EventSource(gameStreamUrl(gameId, ticket)),
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
  }, [queryClient, gameId]);

  return { ...query, live };
}
