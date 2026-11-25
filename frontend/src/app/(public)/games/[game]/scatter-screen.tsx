"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Send } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Countdown, Leaderboard, LetterTile, Results } from "@/components/games/scatter-parts";
import { GuestShell } from "@/components/home/guest-shell";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { usePhonePeople } from "@/hooks/use-phone";
import { useScatterClock } from "@/hooks/use-scatter-clock";
import { api, type ApiError, type OwnScatterAnswer } from "@/lib/api";
import { statusLabel } from "@/lib/games";
import {
  ANSWER_MAX,
  answerBody,
  answeredLine,
  canAnswer,
  draftFrom,
  isDirty,
  roundHeading,
  stateLabel,
} from "@/lib/scatter";
import { cn } from "@/lib/utils";

/**
 * The answer sheet for the running round. Edits sit on top of what the server last confirmed
 * (`saved`), so a reload mid-round restores your answers. It saves on demand and once more when
 * the clock hits zero (the server allows a 2 s grace). Keyed by round and person by the parent,
 * so a new round starts blank.
 */
function AnswerSheet({
  gameId,
  personId,
  categories,
  saved,
  seconds,
  canType,
}: {
  gameId: string;
  personId: string;
  categories: string[];
  saved: string[];
  seconds: number;
  canType: boolean;
}) {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<number, string>>({});
  const draft = saved.map((text, i) => edits[i] ?? text);
  const dirty = isDirty(draft, saved);

  const save = useMutation<OwnScatterAnswer[], ApiError>({
    mutationFn: () =>
      api.submitScatter(gameId, { person_id: personId, answers: answerBody(draft) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] }),
  });

  // One last save as time runs out: the server still accepts it inside the grace window.
  const finalSaved = useRef(false);
  const { mutate } = save;
  useEffect(() => {
    if (seconds === 0 && dirty && !finalSaved.current) {
      finalSaved.current = true;
      mutate();
    }
  }, [seconds, dirty, mutate]);

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="scatter-sheet"
      onSubmit={(event) => {
        event.preventDefault();
        if (canType && dirty && !save.isPending) save.mutate();
      }}
    >
      {categories.map((category, i) => (
        <div key={category} className="flex flex-col gap-1">
          <label htmlFor={`scatter-${i}`} className="text-base font-medium">
            {i + 1}. {category}
          </label>
          <input
            id={`scatter-${i}`}
            data-testid={`scatter-input-${i}`}
            value={draft[i] ?? ""}
            maxLength={ANSWER_MAX}
            disabled={!canType}
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint={i === categories.length - 1 ? "done" : "next"}
            onChange={(event) => setEdits((prev) => ({ ...prev, [i]: event.target.value }))}
            onBlur={() => {
              if (canType && dirty && !save.isPending) save.mutate();
            }}
            className="h-14 w-full rounded-xl border border-input bg-transparent px-4 text-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          />
        </div>
      ))}
      <ApiErrorNotice error={save.error} />
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="scatter-saved"
      >
        {dirty ? (
          "Not saved yet"
        ) : (
          <>
            <Check aria-hidden className="size-4" /> Saved
          </>
        )}
      </p>
      {canType ? (
        <Button
          type="submit"
          size="tap"
          data-testid="primary-action"
          aria-disabled={!dirty || save.isPending}
          className={cn((!dirty || save.isPending) && "opacity-50")}
        >
          <Send aria-hidden /> Save answers
        </Button>
      ) : null}
    </form>
  );
}

/**
 * /games/[game] for Scattergories (ADR-0018 slice C). Join as the current person, then each round:
 * the letter, the categories and a countdown against the server's `ends_at`. Nobody's answers
 * (the host's included) are visible until the host reveals; then the results and the leaderboard
 * appear. A polite live region announces "time's up" and the reveal.
 */
export function ScatterScreen({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const { current: me } = usePhonePeople();
  const data = game.data;
  const scatter = data?.scatter ?? undefined;
  const { state, seconds, round } = useScatterClock(scatter, game.dataUpdatedAt);
  const joined = !!me && !!scatter?.players.some((p) => p.person_id === me.id);

  const mine = useQuery<OwnScatterAnswer[], ApiError>({
    queryKey: ["game", gameId, "mine"],
    queryFn: () => api.myScatterAnswers(gameId),
    enabled: joined,
  });
  const join = useMutation<void, ApiError>({
    mutationFn: () => {
      if (!me) throw new Error("Pick who you are first");
      return api.joinScatter(gameId, me.id);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] }),
  });

  const lastRevealed = scatter?.revealed.at(-1);
  const saved = round
    ? draftFrom(
        round.categories.length,
        (mine.data ?? []).filter((a) => a.person_id === me?.id && a.round_no === round.round_no),
      )
    : [];
  const announcement =
    state === "closed"
      ? "Time is up."
      : state === "revealed"
        ? "The host revealed the answers."
        : "";

  return (
    <GuestShell screen="game" back={{ href: "/games", label: "Games" }}>
      <div
        className="flex flex-col gap-5"
        data-testid="game-screen"
        data-kind="scattergories"
        data-status={data?.status}
        data-round-state={state}
        data-live={game.live}
      >
        {game.error ? <ApiErrorNotice error={game.error} /> : null}
        <p role="status" aria-live="polite" className="sr-only" data-testid="scatter-announce">
          {announcement}
        </p>
        {data && scatter ? (
          <>
            <header className="flex flex-col gap-1">
              <h1 className="font-heading text-3xl font-semibold tracking-tight">{data.title}</h1>
              <p className="text-muted-foreground" data-testid="scatter-status">
                {statusLabel(data.kind, data.status)} · {stateLabel(state, seconds)}
              </p>
            </header>

            {!me ? (
              <p className="rounded-xl bg-muted p-4" data-testid="scatter-pick-person">
                <Link href="/who" className="font-medium underline">
                  Pick who you are
                </Link>{" "}
                to play.
              </p>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Avatar emoji={me.avatar_emoji} color={me.color} size="sm" />
                Playing as {me.name}
              </p>
            )}

            {me && !joined && data.status !== "ended" ? (
              <>
                <ApiErrorNotice error={join.error} />
                <Button
                  size="tap"
                  data-testid="primary-action"
                  disabled={join.isPending}
                  onClick={() => join.mutate()}
                >
                  Join the game
                </Button>
              </>
            ) : null}

            {round && state !== "revealed" ? (
              <section
                className="flex flex-col gap-4"
                aria-label={roundHeading(round.round_no, round.letter)}
              >
                <div className="flex items-center gap-4">
                  <LetterTile letter={round.letter} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h2 className="text-lg font-medium" data-testid="scatter-round-heading">
                      {roundHeading(round.round_no, round.letter)}
                    </h2>
                    <Countdown seconds={seconds} duration={round.duration_seconds} />
                  </div>
                </div>
                {state === "closed" ? (
                  <p
                    className="rounded-2xl bg-muted p-4 text-center text-lg"
                    data-testid="scatter-time-up"
                  >
                    Time is up. Waiting for the host to reveal.
                  </p>
                ) : null}
                {joined && me ? (
                  <AnswerSheet
                    key={`${round.round_no}-${me.id}`}
                    gameId={gameId}
                    personId={me.id}
                    categories={round.categories}
                    saved={saved}
                    seconds={seconds}
                    canType={canAnswer(state, seconds)}
                  />
                ) : (
                  <ul className="flex flex-col gap-1 text-lg">
                    {round.categories.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {state === "lobby" ? (
              <p
                className="rounded-2xl bg-muted p-6 text-center text-lg"
                data-testid="scatter-lobby"
              >
                {data.status === "ended"
                  ? "The game is over."
                  : "The host will start the first round any moment."}
              </p>
            ) : null}

            {scatter.players.length > 0 && round && state !== "revealed" ? (
              <p className="text-sm text-muted-foreground" data-testid="scatter-answered">
                {scatter.players
                  .map((p) => `${p.name}: ${answeredLine(p.answered, round.categories.length)}`)
                  .join(" · ")}
              </p>
            ) : null}

            {state === "revealed" && lastRevealed ? (
              <>
                <h2 className="text-lg font-medium" data-testid="scatter-round-heading">
                  {roundHeading(lastRevealed.round_no, lastRevealed.letter)} results
                </h2>
                <Results round={lastRevealed} standings={scatter.leaderboard} />
              </>
            ) : null}

            {scatter.revealed.length > 0 ? <Leaderboard standings={scatter.leaderboard} /> : null}
          </>
        ) : null}
      </div>
    </GuestShell>
  );
}
