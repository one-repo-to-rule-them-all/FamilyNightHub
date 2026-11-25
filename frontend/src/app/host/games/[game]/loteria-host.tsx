"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, Play, Square } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { HostGameFrame } from "@/components/games/host-game-frame";
import { CurrentCard, LoteriaCalledBoard } from "@/components/games/loteria-parts";
import { ShowOnTvButton } from "@/components/games/show-on-tv-button";
import { Button } from "@/components/ui/button";
import { gameKey, useLiveGame } from "@/hooks/use-live-game";
import {
  api,
  type ApiError,
  type Game,
  type LoteriaCheckResult,
  type LoteriaPlayer,
} from "@/lib/api";
import { playerCountLabel } from "@/lib/game-layout";
import { statusLabel } from "@/lib/games";
import {
  checkResultLine,
  DECK_TOTAL,
  loteriaStripPlayers,
  PATTERN_COPY,
  progressLabel,
  rankPlayers,
  SHOUT,
  winnerLine,
  winnerNames,
} from "@/lib/loteria";

/**
 * Run a Lotería round (ADR-0018 amendment 2026-11-26): let people join (they can reroll their
 * tabla), start the round, draw cards (the draw carries the count the screen showed, so a double
 * tap cannot draw twice) and check a spoken "¡Lotería!" per player against what was called. A
 * false claim just says "not yet". The host sees each player's progress, never their tabla.
 */
export function LoteriaHost({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const step = useMutation<Game, ApiError, "open" | "start" | "end">({
    mutationFn: (action) =>
      action === "open"
        ? api.openLoteria(gameId)
        : action === "start"
          ? api.startLoteria(gameId)
          : api.endGame(gameId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] }),
  });

  const data = game.data;
  const lot = data?.loteria;
  const calls = lot?.calls ?? [];
  const last = lot?.last_call ?? null;

  const draw = useMutation<Game, ApiError>({
    mutationFn: () => api.drawLoteria(gameId, calls.length),
    onSuccess: (next) => queryClient.setQueryData(gameKey(gameId), next),
    // A 409 means the board moved on (a second window, a double tap): reload and carry on.
    onError: () => void queryClient.invalidateQueries({ queryKey: gameKey(gameId) }),
  });

  const [results, setResults] = useState<Record<string, LoteriaCheckResult>>({});
  const check = useMutation<LoteriaCheckResult, ApiError, string>({
    mutationFn: (personId) => api.checkLoteria(gameId, personId),
    onSuccess: (result, personId) => {
      setResults((prev) => ({ ...prev, [personId]: result }));
      void queryClient.invalidateQueries({ queryKey: gameKey(gameId) });
    },
  });

  const players = rankPlayers(lot?.players ?? []);
  const announcement = winnerLine(winnerNames(players));
  const drawError = draw.error && draw.error.status !== 409 ? draw.error : null;

  return (
    <HostGameFrame
      title={data && lot ? data.title : undefined}
      status={
        data && lot
          ? `${statusLabel(data.kind, data.status)} · ${PATTERN_COPY[lot.pattern].name}${
              lot.end_on_first_win ? ", first win ends it" : ", keeps going after a win"
            } · ${playerCountLabel(players.length)}`
          : undefined
      }
      statusTestId="host-loteria-status"
      players={lot ? loteriaStripPlayers(players) : undefined}
      playerTestId="host-loteria-player"
      emptyPlayersText="Nobody has a tabla yet."
      attrs={{
        "data-screen": "portal-game",
        "data-testid": "host-game",
        "data-kind": "loteria",
        "data-status": data?.status,
        "data-live": game.live,
        "data-pattern": lot?.pattern,
      }}
      notice={<ApiErrorNotice error={game.error} />}
    >
      {data && lot ? (
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
                data-testid="host-loteria-winner"
              >
                {announcement}
              </p>
            ) : null}
          </div>

          {data.status === "live" || data.status === "ended" ? (
            <section className="flex flex-col gap-4" aria-label="Calling cards">
              {data.status === "live" ? (
                <Button
                  size="lg"
                  data-testid="host-draw"
                  className="min-h-16 w-full text-xl"
                  disabled={draw.isPending || calls.length >= DECK_TOTAL}
                  onClick={() => draw.mutate()}
                >
                  {calls.length >= DECK_TOTAL ? "Every card has been called" : "Draw next card"}
                </Button>
              ) : null}
              <ApiErrorNotice error={drawError} />
              <div className="text-center">
                <p className="text-sm text-muted-foreground">
                  Last card ({calls.length} of {DECK_TOTAL})
                </p>
                <CurrentCard
                  cardId={last?.card_id ?? null}
                  variant="host"
                  testId="host-last-call"
                />
              </div>
              <LoteriaCalledBoard calls={calls} variant="host" />
              <p className="text-sm text-muted-foreground" data-testid="host-called-list">
                {calls.length === 0
                  ? "Nothing called yet."
                  : `In order: ${calls.map((c) => c.name_es).join(", ")}`}
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
  players: readonly LoteriaPlayer[];
  results: Record<string, LoteriaCheckResult>;
  canCheck: boolean;
  pendingId: string | undefined;
  onCheck: (personId: string) => void;
}) {
  if (players.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">Check {SHOUT}</h2>
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
                  {progressLabel(p)}
                </span>
              </span>
              <Button
                variant="secondary"
                data-testid="host-check-loteria"
                disabled={!canCheck || pendingId === p.person_id}
                onClick={() => onCheck(p.person_id)}
              >
                Check {SHOUT}
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
