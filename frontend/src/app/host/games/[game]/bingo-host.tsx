"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, Play, Square } from "lucide-react";

import { ShowOnTvButton } from "@/components/games/show-on-tv-button";
import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { api, type ApiError, type Game } from "@/lib/api";
import { progressLabel, rankPlayers, WIN_MODE_COPY, winnerLine, winnerNames } from "@/lib/bingo";
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
    <div
      className="flex flex-col gap-5"
      data-screen="portal-game"
      data-testid="host-game"
      data-kind="bingo"
      data-status={data?.status}
      data-live={game.live}
    >
      <ApiErrorNotice error={game.error} />
      {data && bingo ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold">{data.title}</h1>
            <p className="text-muted-foreground" data-testid="host-bingo-status">
              {statusLabel(data.kind, data.status)} · {WIN_MODE_COPY[bingo.win_mode].name}
              {bingo.end_on_first_win ? ", first win ends it" : ", keeps going after a win"} ·{" "}
              {players.length} {players.length === 1 ? "player" : "players"}
            </p>
          </header>

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

          <section className="flex flex-col gap-2" aria-label="Players">
            <h2 className="text-lg font-medium">Players</h2>
            {players.length === 0 ? (
              <p className="text-muted-foreground">Nobody has a card yet.</p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {players.map((p) => (
                <li
                  key={p.person_id}
                  data-testid="host-bingo-player"
                  data-won={p.won ? "true" : "false"}
                  className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3"
                >
                  <Avatar emoji={p.avatar_emoji} color={p.color} size="sm" />
                  <span className="min-w-0 flex-1 font-medium">{p.name}</span>
                  <span className="text-sm text-muted-foreground">{progressLabel(p)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
