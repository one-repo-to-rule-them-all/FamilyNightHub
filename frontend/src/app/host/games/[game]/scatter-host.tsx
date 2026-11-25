"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Dices, Eye, Play, Square } from "lucide-react";
import { useState } from "react";

import { ShowOnTvButton } from "@/components/games/show-on-tv-button";
import { ApiErrorNotice } from "@/components/api-error-notice";
import { Countdown, Leaderboard, LetterTile, Results } from "@/components/games/scatter-parts";
import { HostGameFrame } from "@/components/games/host-game-frame";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { useScatterClock } from "@/hooks/use-scatter-clock";
import { api, type ApiError, type Game, type ScatterAnswer } from "@/lib/api";
import { playerCountLabel, scatterStripPlayers } from "@/lib/game-layout";
import { statusLabel } from "@/lib/games";
import {
  canStartRound,
  categoriesToText,
  DEFAULT_DURATION,
  DURATIONS,
  nextVerdict,
  parseCategories,
  roundHeading,
  stateLabel,
} from "@/lib/scatter";

const DRAW_COUNT = 6;

/** Before each round: draw or type the categories, pick a time, start. */
function RoundSetup({ gameId, nextRound }: { gameId: string; nextRound: number }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);

  const draw = useMutation<string[], ApiError>({
    mutationFn: async () => (await api.scatterDraw(gameId, DRAW_COUNT)).categories,
    onSuccess: (categories) => setText(categoriesToText(categories)),
  });
  const categories = parseCategories(text);
  const start = useMutation<Game, ApiError>({
    mutationFn: () =>
      api.startScatterRound(gameId, {
        categories,
        count: categories.length,
        duration_seconds: duration,
      }),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
    },
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
      data-testid="scatter-setup"
      onSubmit={(event) => {
        event.preventDefault();
        if (canStartRound(categories) && !start.isPending) start.mutate();
      }}
    >
      <h2 className="text-lg font-medium">Round {nextRound}</h2>
      <label htmlFor="scatter-categories" className="text-sm text-muted-foreground">
        Categories, one per line. Draw a set, then change anything you like. The letter is chosen
        when you start.
      </label>
      <textarea
        id="scatter-categories"
        data-testid="scatter-categories"
        value={text}
        rows={7}
        onChange={(event) => setText(event.target.value)}
        className="w-full rounded-xl border border-input bg-transparent p-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          data-testid="scatter-draw"
          disabled={draw.isPending}
          onClick={() => draw.mutate()}
        >
          <Dices aria-hidden /> Draw {DRAW_COUNT}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          Time
          <select
            data-testid="scatter-duration"
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
            className="h-8 rounded-lg border border-input bg-transparent px-2"
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d / 60 >= 1 && d % 60 === 0 ? `${d / 60} min` : `${d} s`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ApiErrorNotice error={draw.error ?? start.error} />
      <Button
        type="submit"
        data-testid="scatter-start"
        disabled={!canStartRound(categories) || start.isPending}
      >
        <Play aria-hidden /> Start round {nextRound}
      </Button>
    </form>
  );
}

/**
 * Run a Scattergories game (ADR-0018 slice C): set up each round, watch the clock and who has
 * answered (never what), reveal, reject or re-accept answers, start the next round, end it. The
 * server derives every score, so a verdict just refetches the snapshot.
 */
export function ScatterHost({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const data = game.data;
  const scatter = data?.scatter ?? undefined;
  const { state, seconds, round } = useScatterClock(scatter, game.dataUpdatedAt);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] });

  const step = useMutation<Game, ApiError, "reveal" | "end">({
    mutationFn: (action) => (action === "reveal" ? api.revealScatter(gameId) : api.endGame(gameId)),
    onSuccess: refresh,
  });
  const judge = useMutation<Game, ApiError, { answer: ScatterAnswer }>({
    mutationFn: ({ answer }) =>
      api.setScatterVerdict(gameId, answer.answer_id, nextVerdict(answer.verdict)),
    onSuccess: refresh,
  });

  const lastRevealed = scatter?.revealed.at(-1);
  const ended = data?.status === "ended";
  const between = !ended && (state === "lobby" || state === "revealed");

  return (
    <HostGameFrame
      title={data && scatter ? data.title : undefined}
      status={
        data && scatter
          ? `${statusLabel(data.kind, data.status)} · ${stateLabel(state, seconds)} · ${playerCountLabel(scatter.players.length)}`
          : undefined
      }
      statusTestId="host-scatter-status"
      players={
        scatter
          ? scatterStripPlayers(
              scatter.players,
              round && (state === "running" || state === "closed") ? round.categories.length : null,
            )
          : undefined
      }
      playerTestId="scatter-player"
      emptyPlayersText="Nobody has joined yet."
      attrs={{
        "data-screen": "portal-game",
        "data-testid": "host-game",
        "data-kind": "scattergories",
        "data-status": data?.status,
        "data-round-state": state,
        "data-live": game.live,
      }}
      notice={<ApiErrorNotice error={game.error} />}
    >
      {data && scatter ? (
        <>
          <div className="flex flex-wrap gap-3">
            {(state === "running" || state === "closed") && !ended ? (
              <Button
                data-testid="scatter-reveal"
                disabled={step.isPending}
                onClick={() => step.mutate("reveal")}
              >
                <Eye aria-hidden /> {state === "running" ? "Reveal now" : "Reveal answers"}
              </Button>
            ) : null}
            {!ended ? (
              <Button
                variant="secondary"
                data-testid="end-game"
                disabled={step.isPending}
                onClick={() => step.mutate("end")}
              >
                <Square aria-hidden /> End game
              </Button>
            ) : null}
            <ShowOnTvButton gameId={gameId} />
          </div>
          <ApiErrorNotice error={step.error ?? judge.error} />

          {round && (state === "running" || state === "closed") ? (
            <section className="flex flex-col gap-3" aria-label="Round in progress">
              <div className="flex items-center gap-4">
                <LetterTile letter={round.letter} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h2 className="text-lg font-medium">
                    {roundHeading(round.round_no, round.letter)}
                  </h2>
                  <Countdown seconds={seconds} duration={round.duration_seconds} />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Answers stay hidden from everyone, you included, until you reveal.
              </p>
            </section>
          ) : null}

          {state === "revealed" && lastRevealed ? (
            <section className="flex flex-col gap-3" aria-label="Results">
              <h2 className="text-lg font-medium">
                {roundHeading(lastRevealed.round_no, lastRevealed.letter)} results
              </h2>
              <p className="text-sm text-muted-foreground">
                Reject an answer that does not fit, or accept it back. Scores update at once.
              </p>
              <Results
                round={lastRevealed}
                standings={scatter.leaderboard}
                action={(answer) => (
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    data-testid={answer.verdict === "rejected" ? "accept-answer" : "reject-answer"}
                    aria-label={`${answer.verdict === "rejected" ? "Accept" : "Reject"}: ${answer.text}`}
                    disabled={judge.isPending}
                    onClick={() => judge.mutate({ answer })}
                  >
                    {answer.verdict === "rejected" ? <Check aria-hidden /> : <Ban aria-hidden />}
                  </Button>
                )}
              />
            </section>
          ) : null}

          {between ? (
            <RoundSetup
              key={scatter.revealed.length}
              gameId={gameId}
              nextRound={(round?.round_no ?? 0) + 1}
            />
          ) : null}

          {scatter.revealed.length > 0 ? <Leaderboard standings={scatter.leaderboard} /> : null}
        </>
      ) : null}
    </HostGameFrame>
  );
}
