"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type Game } from "@/lib/api";

import { GameLoading } from "@/components/games/game-loading";

import { TvBingo } from "./tv-bingo";
import { TvJar } from "./tv-jar";
import { TvScatter } from "./tv-scatter";

/** Picks the TV screen for a game's kind (one shared `["game", id]` query). */
export function TvGameRoute({ gameId }: { gameId: string }) {
  const game = useQuery<Game, ApiError>({
    queryKey: ["game", gameId],
    queryFn: () => api.game(gameId),
  });
  if (game.data?.kind === "bingo") return <TvBingo gameId={gameId} />;
  if (game.data?.kind === "scattergories") return <TvScatter gameId={gameId} />;
  // Until the kind is known, show nothing game-specific: the jar screens fire jar-only
  // requests (a 404 on a bingo round) and flash for a moment.
  if (game.isPending) {
    return <GameLoading />;
  }
  return <TvJar gameId={gameId} />;
}
