"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PhoneGameFrame } from "@/components/games/phone-game-frame";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { usePhonePeople } from "@/hooks/use-phone";
import { api, type ApiError, type BingoCard } from "@/lib/api";
import {
  bingoStatusLine,
  canTapSquare,
  FREE_LABEL,
  markedSet,
  progressLabel,
  rankPlayers,
  squareLabel,
  winnerLine,
  winnerNames,
} from "@/lib/bingo";
import { bingoStripPlayers } from "@/lib/game-layout";
import { statusLabel } from "@/lib/games";
import { cn } from "@/lib/utils";

/**
 * /games/[game] for Thanksgiving Bingo (ADR-0018 slice B). The card is yours alone (read from
 * `/bingo/mine`); the shared snapshot only carries each player's progress. A mark is a check
 * glyph plus colour, never colour alone, and each square is a 56px+ toggle button with
 * `aria-pressed`. There is no "bingo" button: the mark that completes the pattern wins, and the
 * server says so. The wins are announced in a polite live region.
 */
export function BingoScreen({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const { current } = usePhonePeople();
  const cardKey = ["game", gameId, "bingo-mine"] as const;

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

  const data = game.data;
  const players = data?.bingo?.players ?? [];
  const announcement = winnerLine(winnerNames(players));
  const marked = markedSet(card?.marked ?? []);

  return (
    <PhoneGameFrame
      title={data?.title}
      status={
        data
          ? `${statusLabel(data.kind, data.status)} · ${bingoStatusLine(data.status, !!card)}`
          : undefined
      }
      statusTestId="bingo-status"
      players={data ? bingoStripPlayers(rankPlayers(players)) : undefined}
      emptyPlayersText="Players show up here as they get their cards"
      attrs={{ "data-kind": "bingo", "data-status": data?.status, "data-live": game.live }}
      notice={game.error ? <ApiErrorNotice error={game.error} /> : null}
    >
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

          {card ? (
            <>
              <p className="text-sm text-muted-foreground" data-testid="bingo-progress">
                {progressLabel({
                  squares_from_bingo: card.squares_from_bingo,
                  won: card.won,
                })}
              </p>
              <ul
                className="grid grid-cols-5 gap-1.5"
                aria-label="Your bingo card"
                data-testid="bingo-card"
              >
                {card.squares.map((square, index) => {
                  const isMarked = marked.has(index);
                  const free = square === FREE_LABEL;
                  return (
                    <li key={`${index}-${square}`} className="contents">
                      <button
                        type="button"
                        data-testid="bingo-square"
                        data-index={index}
                        aria-pressed={isMarked}
                        aria-label={squareLabel(square, index, isMarked)}
                        disabled={!canTapSquare(data.status, square) || mark.isPending}
                        onClick={() => mark.mutate({ index, marked: !isMarked })}
                        className={cn(
                          "relative flex aspect-square min-h-14 items-center justify-center rounded-lg border p-0.5 text-center text-[0.68rem] leading-tight font-medium break-words outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm",
                          isMarked
                            ? "border-[var(--accent-cinema)] bg-[var(--accent-cinema)]/20 text-foreground"
                            : "border-foreground/15 bg-card text-foreground",
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
              <ApiErrorNotice error={mark.error} />
            </>
          ) : null}
        </>
      ) : null}
    </PhoneGameFrame>
  );
}
