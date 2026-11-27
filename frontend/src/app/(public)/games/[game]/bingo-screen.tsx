"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PhoneGameFrame } from "@/components/games/phone-game-frame";
import { ResultMoment } from "@/components/games/result-moment";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { usePhonePeople } from "@/hooks/use-phone";
import { api, type ApiError, type BingoCard } from "@/lib/api";
import {
  BINGO_LETTERS,
  WIN_MODE_COPY,
  bingoStatusLine,
  callParts,
  calledSet,
  canTapSquare,
  canMarkClassic,
  classicSquareLabel,
  classicStatusLine,
  FREE_LABEL,
  markedSet,
  markedToGo,
  notCalledMessage,
  progressLabel,
  rankPlayers,
  recentCalls,
  spacedLabel,
  squareLabel,
  squareIsCalled,
  winnerLine,
  winnerNames,
} from "@/lib/bingo";
import { placedResult } from "@/lib/result-moment";
import { bingoStripPlayers } from "@/lib/game-layout";
import { statusLabel } from "@/lib/games";
import { cn } from "@/lib/utils";

/**
 * /games/[game] for Thanksgiving Bingo (ADR-0018 slice B). The card is yours alone (read from
 * `/bingo/mine`); the shared snapshot only carries each player's progress. A mark is a check
 * glyph plus colour, never colour alone, and each square is a 56px+ toggle button with
 * `aria-pressed`. There is no "bingo" button: in Thanksgiving the mark that completes the pattern
 * wins, and the server says so; in a classic round (amendment 2026-11-25) people say "bingo" aloud
 * and the host checks. A classic card shows the last call and the last five, an uncalled square is
 * `aria-disabled` (not just dimmed) and a tap says why, and the server refuses it too (409).
 * The wins are announced in a polite live region.
 */
export function BingoScreen({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const { current } = usePhonePeople();
  const cardKey = ["game", gameId, "bingo-mine"] as const;
  const [hint, setHint] = useState<string | null>(null);

  const mine = useQuery<BingoCard[], ApiError>({
    queryKey: cardKey,
    queryFn: () => api.myBingoCards(gameId),
  });
  const card = current ? mine.data?.find((c) => c.person_id === current.id) : undefined;

  const join = useMutation<BingoCard, ApiError>({
    mutationFn: () => {
      if (!current) throw new Error("Pick who you are first");
      return api.joinBingo(gameId, current.id);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] }),
  });
  const mark = useMutation<BingoCard, ApiError, { index: number; marked: boolean }>({
    mutationFn: ({ index, marked }) => {
      if (!current) throw new Error("Pick who you are first");
      return api.markBingoSquare(gameId, index, current.id, marked);
    },
    onSuccess: (next) => {
      queryClient.setQueryData<BingoCard[]>(cardKey, (old) =>
        (old ?? []).map((c) => (c.person_id === next.person_id ? next : c)),
      );
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
    },
  });

  const reroll = useMutation<BingoCard, ApiError>({
    mutationFn: () => {
      if (!current) throw new Error("Pick who you are first");
      return api.rerollBingoCard(gameId, current.id);
    },
    onSuccess: (next) => {
      queryClient.setQueryData<BingoCard[]>(cardKey, (old) =>
        (old ?? []).map((c) => (c.person_id === next.person_id ? next : c)),
      );
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
      setHint("You have a new card.");
    },
  });

  const data = game.data;
  const players = data?.bingo?.players ?? [];
  const announcement = winnerLine(winnerNames(players));
  const marked = markedSet(card?.marked ?? []);
  const classic = data?.bingo?.mode === "classic";
  const calls = data?.bingo?.calls ?? [];
  const last = data?.bingo?.last_call ?? null;
  const called = calledSet(calls);
  const result = placedResult(
    data?.status,
    current?.id,
    players,
    data?.bingo ? WIN_MODE_COPY[data.bingo.win_mode].name : null,
  );

  return (
    <PhoneGameFrame
      title={data?.title}
      status={
        data
          ? `${statusLabel(data.kind, data.status)} · ${
              classic
                ? classicStatusLine(data.status, !!card, calls.length)
                : bingoStatusLine(data.status, !!card)
            }`
          : undefined
      }
      statusTestId="bingo-status"
      players={data ? bingoStripPlayers(rankPlayers(players), { progress: !classic }) : undefined}
      emptyPlayersText="Players show up here as they get their cards"
      attrs={{ "data-kind": "bingo", "data-status": data?.status, "data-live": game.live }}
      notice={game.error ? <ApiErrorNotice error={game.error} /> : null}
    >
      <ResultMoment gameId={gameId} personId={current?.id} decision={result} />
      {data ? (
        <>
          <div aria-live="polite" data-testid="bingo-announcement">
            {announcement ? (
              <p className="rounded-2xl bg-card p-4 text-xl font-semibold marquee-glow">
                {announcement}
              </p>
            ) : null}
          </div>

          {!current ? (
            <p className="rounded-xl bg-muted p-4" data-testid="bingo-pick-person">
              <Link href="/who" className="font-medium underline">
                Pick who you are
              </Link>{" "}
              to play.
            </p>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Avatar emoji={current.avatar_emoji} color={current.color} size="sm" />
              Playing as {current.name}
            </p>
          )}

          {current && !card && (data.status === "open" || data.status === "live") ? (
            <>
              <ApiErrorNotice error={join.error} />
              <Button
                size="lg"
                data-testid="primary-action"
                className="min-h-14 w-full text-lg"
                disabled={join.isPending}
                onClick={() => join.mutate()}
              >
                Get my card
              </Button>
            </>
          ) : null}

          {classic && (data.status === "live" || data.status === "ended") ? (
            <div className="flex flex-col gap-0.5 rounded-xl border border-foreground/10 bg-card px-3 py-2">
              <p className="text-xs text-muted-foreground">Last call</p>
              <p
                aria-live="polite"
                aria-label={last ? `Last call ${last.label}` : "No number called yet"}
                data-testid="bingo-last-call"
                data-value={last?.value}
                className="font-heading text-4xl leading-none font-bold tabular-nums"
              >
                {last ? spacedLabel(last) : "—"}
              </p>
              <p
                className="truncate text-xs whitespace-nowrap text-muted-foreground"
                data-testid="bingo-recent-calls"
              >
                {recentCalls(calls).length > 0 ? (
                  <>
                    Before:{" "}
                    {recentCalls(calls).map((c, i) => {
                      const { letter, number } = callParts(c);
                      return (
                        <span key={c.seq} className="whitespace-nowrap">
                          {i > 0 ? ", " : ""}
                          <strong className="font-bold text-foreground">{letter}</strong>
                          <span className="text-foreground">{number}</span>
                        </span>
                      );
                    })}
                  </>
                ) : (
                  "Numbers show up here as the host calls them."
                )}
              </p>
            </div>
          ) : null}

          {card ? (
            <>
              <p className="sr-only" aria-live="polite" data-testid="bingo-progress">
                {progressLabel({
                  squares_from_bingo: classic
                    ? markedToGo(card.marked, data.bingo?.win_mode ?? "line")
                    : card.squares_from_bingo,
                  won: card.won,
                })}
              </p>
              {classic ? (
                <div
                  aria-hidden
                  data-testid="bingo-card-header"
                  className="-mb-1 grid grid-cols-5 gap-1.5 text-center font-heading text-2xl font-bold"
                >
                  {BINGO_LETTERS.map((letter) => (
                    <span key={letter}>{letter}</span>
                  ))}
                </div>
              ) : null}
              <ul
                className="grid grid-cols-5 gap-1.5"
                aria-label="Your bingo card"
                data-testid="bingo-card"
              >
                {card.squares.map((square, index) => {
                  const isMarked = marked.has(index);
                  const free = square === FREE_LABEL;
                  const isCalled = !classic || squareIsCalled(square, called);
                  // Classic: an uncalled square stays focusable so a tap can say why.
                  const inactive = classic && !isCalled && !isMarked;
                  return (
                    <li key={`${index}-${square}`} className="contents">
                      <button
                        type="button"
                        data-testid="bingo-square"
                        data-index={index}
                        aria-pressed={isMarked}
                        aria-label={
                          classic
                            ? classicSquareLabel(square, index, isMarked, isCalled)
                            : squareLabel(square, index, isMarked)
                        }
                        aria-disabled={inactive || undefined}
                        data-called={classic ? isCalled : undefined}
                        disabled={!canTapSquare(data.status, square) || mark.isPending}
                        onClick={() => {
                          if (inactive) {
                            setHint(
                              data.status === "live"
                                ? notCalledMessage(square)
                                : "The round hasn't started.",
                            );
                            return;
                          }
                          if (
                            classic &&
                            !isMarked &&
                            !canMarkClassic(data.status, square, called)
                          ) {
                            return;
                          }
                          setHint(null);
                          mark.mutate({ index, marked: !isMarked });
                        }}
                        className={cn(
                          "relative flex aspect-square min-h-14 items-center justify-center rounded-lg border p-0.5 text-center text-[0.68rem] leading-tight font-medium break-words outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm",
                          isMarked
                            ? "border-[var(--accent-cinema)] bg-[var(--accent-cinema)]/20 text-foreground"
                            : "border-foreground/15 bg-card text-foreground",
                          inactive && "border-dashed text-muted-foreground opacity-60",
                          free && "font-semibold",
                        )}
                      >
                        {isMarked ? (
                          <Check
                            aria-hidden
                            className="absolute top-0.5 right-0.5 size-3.5 text-[var(--accent-cinema)]"
                          />
                        ) : null}
                        <span>{square}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p
                role="status"
                className="min-h-6 text-sm text-muted-foreground"
                data-testid="bingo-hint"
              >
                {hint}
              </p>
              <ApiErrorNotice error={mark.error} />
              {data.status === "open" ? (
                <>
                  <ApiErrorNotice error={reroll.error} />
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="bingo-reroll"
                    aria-label="New card: replaces your current card with a new one"
                    className="min-h-14 w-full text-lg"
                    disabled={reroll.isPending}
                    onClick={() => reroll.mutate()}
                  >
                    New card
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </PhoneGameFrame>
  );
}
