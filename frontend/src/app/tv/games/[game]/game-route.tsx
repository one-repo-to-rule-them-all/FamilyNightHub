"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { api, type ApiError, type Game } from "@/lib/api";
import { holdRemainingMs, releasedGames, shouldLeaveTv } from "@/lib/tv-hold";
import { useTvTargetState } from "@/lib/tv-target";

import { GameLoading } from "@/components/games/game-loading";

import { TvBingo } from "./tv-bingo";
import { TvJar } from "./tv-jar";
import { TvLoteria } from "./tv-loteria";
import { TvScatter } from "./tv-scatter";

/**
 * Keeps the paired TV on what the host chose: once the host has sent this game, the TV leaves
 * when they send another or press Back to QR. When the game ends, the TV holds its result
 * screen for `TV_HOLD_MS` (lib/tv-hold.ts), then goes back to /tv and its usual order. A game
 * screen opened by hand (never sent) stays put.
 */
function useFollowHost(gameId: string) {
  const router = useRouter();
  const sent = useTvTargetState();
  const wasSent = useRef(false);
  const observedAt = useRef<number | null>(null);
  // Bumped by the hold timer so the decision runs again when the hold is over.
  const [tick, setTick] = useState(0);
  const target = sent.data;
  useEffect(() => {
    if (!target) return;
    if (target.game_id === gameId) {
      wasSent.current = true;
      return;
    }
    if (target.game_id) {
      router.replace(`/tv/games/${target.game_id}`);
      return;
    }
    if (target.ended_game_id === gameId) {
      observedAt.current ??= Date.now();
      if (shouldLeaveTv(gameId, target, observedAt.current, Date.now())) {
        releasedGames.add(gameId);
        router.replace("/tv");
        return;
      }
      const timer = window.setTimeout(
        () => setTick((n) => n + 1),
        holdRemainingMs(target, observedAt.current, Date.now()) + 50,
      );
      return () => window.clearTimeout(timer);
    }
    if (wasSent.current) router.replace("/tv");
  }, [target, gameId, router, tick]);
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
