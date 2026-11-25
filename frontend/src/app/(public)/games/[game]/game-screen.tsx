"use client";

import { useQuery } from "@tanstack/react-query";

import { gameKey } from "@/hooks/use-live-game";
import { api, type ApiError, type Game } from "@/lib/api";

import { JarScreen } from "./jar-screen";
import { ScatterScreen } from "./scatter-screen";

/** Picks the phone screen for the game's kind. Shares the live hook's query, so no second fetch. */
export function GameScreen({ gameId }: { gameId: string }) {
  const kind = useQuery<Game, ApiError>({
    queryKey: gameKey(gameId),
    queryFn: () => api.game(gameId),
  });
  if (kind.data?.kind === "scattergories") return <ScatterScreen gameId={gameId} />;
  return <JarScreen gameId={gameId} />;
}
