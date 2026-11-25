"use client";

import { useQuery } from "@tanstack/react-query";

import { gameKey } from "@/hooks/use-live-game";
import { api, type ApiError, type Game } from "@/lib/api";

import { JarHost } from "./jar-host";
import { ScatterHost } from "./scatter-host";

/** Picks the host's control surface for the game's kind. */
export function GameHost({ gameId }: { gameId: string }) {
  const kind = useQuery<Game, ApiError>({
    queryKey: gameKey(gameId),
    queryFn: () => api.game(gameId),
  });
  if (kind.data?.kind === "scattergories") return <ScatterHost gameId={gameId} />;
  return <JarHost gameId={gameId} />;
}
