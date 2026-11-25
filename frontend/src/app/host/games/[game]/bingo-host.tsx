"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, Play, Square } from "lucide-react";

import { ShowOnTvButton } from "@/components/games/show-on-tv-button";
import { ApiErrorNotice } from "@/components/api-error-notice";
import { HostGameFrame } from "@/components/games/host-game-frame";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { api, type ApiError, type Game } from "@/lib/api";
import { rankPlayers, WIN_MODE_COPY, winnerLine, winnerNames } from "@/lib/bingo";
import { bingoStripPlayers, playerCountLabel } from "@/lib/game-layout";
import { statusLabel } from "@/lib/games";

/**
 * Run a bingo round (ADR-0018 slice B): open it for players, start it, end it any time. Marks are
 * an honour system, so the host is the referee; the first win ends the round unless the round was
 * set up to keep going. The host sees each player's progress, never their squares.
 */
export function BingoHost({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const step = useMutation<Game, ApiError, "open" | "start" | "end">({
    mutationFn: (action) =>
      action === "open"
        ? api.openGame(gameId)
        : action === "start"
          ? api.startGame(gameId)
          : api.endGame(gameId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] }),
  });

  const data = game.data;
  const bingo = data?.bingo;
  const players = rankPlayers(bingo?.players ?? []);
  const announcement = winnerLine(winnerNames(players));

  return (
    <HostGameFrame
      title={data && bingo ? data.title : undefined}
      status={
        data && bingo
          ? `${statusLabel(data.kind, data.status)} · ${WIN_MODE_COPY[bingo.win_mode].name}${
              bingo.end_on_first_win ? ", first win ends it" : ", keeps going after a win"
            } · ${playerCountLabel(players.length)}`
          : undefined
      }
      statusTestId="host-bingo-status"
      players={bingo ? bingoStripPlayers(players) : undefined}
      playerTestId="host-bingo-player"
      emptyPlayersText="Nobody has a card yet."
      attrs={{
        "data-screen": "portal-game",
        "data-testid": "host-game",
        "data-kind": "bingo",
        "data-status": data?.status,
        "data-live": game.live,
      }}
      notice={<ApiErrorNotice error={game.error} />}
    >
      {data && bingo ? (
        <>
          <div className="flex flex-wrap gap-3">
            {data.status === "draft" ? (
              <Button
                data-testid="open-game"
                disabled={step.isPending}
                onClick={() => step.mutate("open")}
              >
                <DoorOpen aria-hidden /> Let people join
              </Button>
            ) : null}
            {data.status === "open" ? (
              <Button
                data-testid="start-round"
                disabled={players.length === 0 || step.isPending}
                onClick={() => step.mutate("start")}
              >
                <Play aria-hidden /> Start the round
              </Button>
            ) : null}
            {data.status !== "ended" ? (
              <Button
                variant="secondary"
                data-testid="end-game"
                disabled={step.isPending}
                onClick={() => step.mutate("end")}
              >
                <Square aria-hidden /> End
              </Button>
            ) : null}
            <ShowOnTvButton gameId={gameId} />
          </div>
          <ApiErrorNotice error={step.error} />

          <div aria-live="polite">
            {announcement ? (
              <p
                className="rounded-2xl bg-card p-4 text-lg font-semibold"
                data-testid="host-bingo-winner"
              >
                {announcement}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </HostGameFrame>
  );
}
