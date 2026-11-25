"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, Play, Square } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { CalledBoard } from "@/components/games/called-board";
import { HostGameFrame } from "@/components/games/host-game-frame";
import { ShowOnTvButton } from "@/components/games/show-on-tv-button";
import { Button } from "@/components/ui/button";
import { gameKey, useLiveGame } from "@/hooks/use-live-game";
import { api, type ApiError, type BingoCheckResult, type BingoPlayer, type Game } from "@/lib/api";
import {
  checkResultLine,
  rankPlayers,
  spacedLabel,
  WIN_MODE_COPY,
  winnerLine,
  winnerNames,
} from "@/lib/bingo";
import { bingoStripPlayers, playerCountLabel } from "@/lib/game-layout";
import { statusLabel } from "@/lib/games";

const MAX_CALLS = 75;

/**
 * Run a bingo round (ADR-0018 slice B): open it for players, start it, end it any time. The host
 * sees each player's progress, never their squares.
 *
 * Thanksgiving marks are an honour system, so the host is the referee; the first win ends the
 * round unless the round was set up to keep going. In a classic round (amendment 2026-11-25) the
 * host draws the numbers (the draw carries the count the screen showed, so a double tap cannot
 * draw twice) and checks a spoken "bingo" per player against what was called; a false claim just
 * says "not yet".
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
  const classic = bingo?.mode === "classic";
  const calls = bingo?.calls ?? [];
  const last = bingo?.last_call ?? null;

  const draw = useMutation<Game, ApiError>({
    mutationFn: () => api.drawBingo(gameId, calls.length),
    onSuccess: (next) => queryClient.setQueryData(gameKey(gameId), next),
    // A 409 means the board moved on (a second window, a double tap): reload and carry on.
    onError: () => void queryClient.invalidateQueries({ queryKey: gameKey(gameId) }),
  });

  const [results, setResults] = useState<Record<string, BingoCheckResult>>({});
  const check = useMutation<BingoCheckResult, ApiError, string>({
    mutationFn: (personId) => api.checkBingo(gameId, personId),
    onSuccess: (result, personId) => {
      setResults((prev) => ({ ...prev, [personId]: result }));
      // A valid check ends the round (by default): the snapshot says so.
      void queryClient.invalidateQueries({ queryKey: gameKey(gameId) });
    },
  });

  const players = rankPlayers(bingo?.players ?? []);
  const announcement = winnerLine(winnerNames(players));
  const drawError = draw.error && draw.error.status !== 409 ? draw.error : null;

  return (
    <HostGameFrame
      title={data && bingo ? data.title : undefined}
      status={
        data && bingo
          ? `${statusLabel(data.kind, data.status)} · ${classic ? "Classic, " : ""}${WIN_MODE_COPY[bingo.win_mode].name}${
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
        "data-mode": bingo?.mode,
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

          {classic && (data.status === "live" || data.status === "ended") ? (
            <section className="flex flex-col gap-4" aria-label="Calling numbers">
              {data.status === "live" ? (
                <Button
                  size="lg"
                  data-testid="host-draw"
                  className="min-h-16 w-full text-xl"
                  disabled={draw.isPending || calls.length >= MAX_CALLS}
                  onClick={() => draw.mutate()}
                >
                  {calls.length >= MAX_CALLS ? "Every number has been called" : "Draw next number"}
                </Button>
              ) : null}
              <ApiErrorNotice error={drawError} />
              <div className="text-center" aria-live="polite">
                <p className="text-sm text-muted-foreground">
                  Last call ({calls.length} of {MAX_CALLS})
                </p>
                <p
                  data-testid="host-last-call"
                  data-value={last?.value}
                  className="font-heading text-8xl leading-none font-bold tabular-nums"
                >
                  {last ? spacedLabel(last) : "—"}
                </p>
              </div>
              <CalledBoard calls={calls} variant="host" />
              <p className="text-sm text-muted-foreground" data-testid="host-called-list">
                {calls.length === 0
                  ? "Nothing called yet."
                  : `In order: ${calls.map((c) => c.label).join(", ")}`}
              </p>
              <CheckList
                players={players}
                results={results}
                canCheck={data.status === "live"}
                pendingId={check.isPending ? check.variables : undefined}
                onCheck={(id) => check.mutate(id)}
              />
              <ApiErrorNotice error={check.error} />
            </section>
          ) : null}
        </>
      ) : null}
    </HostGameFrame>
  );
}

function CheckList({
  players,
  results,
  canCheck,
  pendingId,
  onCheck,
}: {
  players: readonly BingoPlayer[];
  results: Record<string, BingoCheckResult>;
  canCheck: boolean;
  pendingId: string | undefined;
  onCheck: (personId: string) => void;
}) {
  if (players.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">Check bingo</h2>
      <ul className="flex flex-col gap-2">
        {players.map((p) => {
          const result = results[p.person_id];
          return (
            <li
              key={p.person_id}
              data-testid="host-check-row"
              data-person-id={p.person_id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3"
            >
              <span className="min-w-0 flex-1 font-medium">
                {p.avatar_emoji} {p.name}
                <span className="block text-sm font-normal text-muted-foreground">
                  {p.won
                    ? "Bingo!"
                    : p.squares_from_bingo === 1
                      ? "1 away"
                      : `${p.squares_from_bingo} to go`}
                </span>
              </span>
              <Button
                variant="secondary"
                data-testid="host-check-bingo"
                disabled={!canCheck || pendingId === p.person_id}
                onClick={() => onCheck(p.person_id)}
              >
                Check bingo
              </Button>
              {result ? (
                <p
                  role="status"
                  data-testid="host-check-result"
                  data-valid={result.valid}
                  className="w-full text-sm"
                >
                  {checkResultLine(p.name, result)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
