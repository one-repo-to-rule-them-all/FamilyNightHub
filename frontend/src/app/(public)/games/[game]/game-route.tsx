"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type Game } from "@/lib/api";

import { BingoScreen } from "./bingo-screen";
import { JarScreen } from "./jar-screen";
import { ScatterScreen } from "./scatter-screen";

/**
 * Picks the phone screen for a game's kind. It reads the same `["game", id]` query the live hook
 * does (so there is one request, and the kind screen opens the one SSE stream).
 */
export function GameRoute({ gameId }: { gameId: string }) {
  const game = useQuery<Game, ApiError>({
    queryKey: ["game", gameId],
    queryFn: () => api.game(gameId),
  });
  if (game.data?.kind === "bingo") return <BingoScreen gameId={gameId} />;
  if (game.data?.kind === "scattergories") return <ScatterScreen gameId={gameId} />;
  return <JarScreen gameId={gameId} />;
}
