"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { api, type ApiError, type Game } from "@/lib/api";
import { useTvTarget } from "@/lib/tv-target";

import { GameLoading } from "@/components/games/game-loading";

import { TvBingo } from "./tv-bingo";
import { TvJar } from "./tv-jar";
import { TvLoteria } from "./tv-loteria";
import { TvScatter } from "./tv-scatter";

/**
 * Keeps the paired TV on what the host chose: once the host has sent this game, the TV leaves
 * when they send another, press Back to QR, or the game ends. A game screen opened by hand
 * (never sent) stays put.
 */
function useFollowHost(gameId: string) {
  const router = useRouter();
  const sent = useTvTarget();
  const wasSent = useRef(false);
  useEffect(() => {
    if (sent.data === undefined) return;
    if (sent.data === gameId) wasSent.current = true;
    else if (sent.data) router.replace(`/tv/games/${sent.data}`);
    else if (wasSent.current) router.replace("/tv");
  }, [sent.data, gameId, router]);
}

/** Picks the TV screen for a game's kind (one shared `["game", id]` query). */
export function TvGameRoute({ gameId }: { gameId: string }) {
  useFollowHost(gameId);
  const game = useQuery<Game, ApiError>({
    queryKey: ["game", gameId],
    queryFn: () => api.game(gameId),
  });
  if (game.data?.kind === "bingo") return <TvBingo gameId={gameId} />;
  if (game.data?.kind === "scattergories") return <TvScatter gameId={gameId} />;
  if (game.data?.kind === "loteria") return <TvLoteria gameId={gameId} />;
  // Until the kind is known, show nothing game-specific: the jar screens fire jar-only
  // requests (a 404 on a bingo round) and flash for a moment.
  if (game.isPending) {
    return <GameLoading />;
  }
  return <TvJar gameId={gameId} />;
}
