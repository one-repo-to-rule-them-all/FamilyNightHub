"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError, type Game } from "@/lib/api";

import { BingoHost } from "./bingo-host";
import { JarHost } from "./jar-host";

/** Picks the host's control surface for a game's kind (one shared `["game", id]` query). */
export function HostGameRoute({ gameId }: { gameId: string }) {
  const game = useQuery<Game, ApiError>({
    queryKey: ["game", gameId],
    queryFn: () => api.game(gameId),
  });
  if (game.data?.kind === "bingo") return <BingoHost gameId={gameId} />;
  return <JarHost gameId={gameId} />;
}
