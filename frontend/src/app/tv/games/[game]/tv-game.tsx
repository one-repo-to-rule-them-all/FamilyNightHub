"use client";

import { useQuery } from "@tanstack/react-query";

import { gameKey } from "@/hooks/use-live-game";
import { api, type ApiError, type Game } from "@/lib/api";

import { TvJar } from "./tv-jar";
import { TvScatter } from "./tv-scatter";

/** Picks the TV screen for the game's kind. */
export function TvGame({ gameId }: { gameId: string }) {
  const kind = useQuery<Game, ApiError>({
    queryKey: gameKey(gameId),
    queryFn: () => api.game(gameId),
  });
  if (kind.data?.kind === "scattergories") return <TvScatter gameId={gameId} />;
  return <TvJar gameId={gameId} />;
}
