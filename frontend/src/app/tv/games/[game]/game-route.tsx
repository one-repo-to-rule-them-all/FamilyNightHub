"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type Game } from "@/lib/api";

import { TvBingo } from "./tv-bingo";
import { TvJar } from "./tv-jar";

/** Picks the TV screen for a game's kind (one shared `["game", id]` query). */
export function TvGameRoute({ gameId }: { gameId: string }) {
  const game = useQuery<Game, ApiError>({
    queryKey: ["game", gameId],
    queryFn: () => api.game(gameId),
  });
  if (game.data?.kind === "bingo") return <TvBingo gameId={gameId} />;
  return <TvJar gameId={gameId} />;
}
