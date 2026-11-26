"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Shuffle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { CurrentCard } from "@/components/games/loteria-parts";
import { PhoneGameFrame } from "@/components/games/phone-game-frame";
import { ResultMoment } from "@/components/games/result-moment";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { usePhonePeople } from "@/hooks/use-phone";
import { api, type ApiError, type LoteriaTabla } from "@/lib/api";
import { statusLabel } from "@/lib/games";
import {
  calledSet,
  canMark,
  loteriaStripPlayers,
  markedSet,
  notCalledMessage,
  PATTERN_COPY,
  progressLabel,
  rankPlayers,
  recentCalls,
  squareLabel,
  statusLine,
  winnerLine,
  winnerNames,
} from "@/lib/loteria";
import { placedResult } from "@/lib/result-moment";
import { cardById } from "@/lib/loteria-deck";
import { cn } from "@/lib/utils";

/**
 * /games/[game] for Lotería (ADR-0018 amendment 2026-11-26). The tabla is yours alone (read from
 * `/loteria/mine`); the shared snapshot only carries each player's progress. Each picture is a
 * 56px+ toggle with `aria-pressed`; a mark is a check glyph plus colour. There is no "Lotería"
 * button: people shout it and the host checks. A picture that has not been called is
 * `aria-disabled` (not just dimmed) and a tap says why; the server refuses it too (409). While the
 * game is open, "Get another tabla" swaps your tabla as often as you like. Calls and wins are
 * announced in polite live regions.
 */
export function LoteriaScreen({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const { current } = usePhonePeople();
  const tablaKey = ["game", gameId, "loteria-mine"] as const;
  const [hint, setHint] = useState<string | null>(null);

  const mine = useQuery<LoteriaTabla[], ApiError>({
    queryKey: tablaKey,
    queryFn: () => api.myLoteriaTablas(gameId),
  });
  const tabla = current ? mine.data?.find((t) => t.person_id === current.id) : undefined;

  const store = (next: LoteriaTabla) => {
    queryClient.setQueryData<LoteriaTabla[]>(tablaKey, (old) => {
      const rest = (old ?? []).filter((t) => t.person_id !== next.person_id);
      return [...rest, next];
    });
    void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
  };
  const join = useMutation<LoteriaTabla, ApiError>({
    mutationFn: () => {
      if (!current) throw new Error("Pick who you are first");
      return api.joinLoteria(gameId, current.id);
    },
    onSuccess: store,
  });
  const reroll = useMutation<LoteriaTabla, ApiError>({
    mutationFn: () => {
      if (!current) throw new Error("Pick who you are first");
      return api.rerollLoteria(gameId, current.id);
    },
    onSuccess: (next) => {
      setHint(null);
      store(next);
    },
  });
  const mark = useMutation<LoteriaTabla, ApiError, { index: number; marked: boolean }>({
    mutationFn: ({ index, marked }) => {
      if (!current) throw new Error("Pick who you are first");
      return api.markLoteriaSquare(gameId, index, current.id, marked);
    },
    onSuccess: store,
  });

  const data = game.data;
  const lot = data?.loteria;
  const players = lot?.players ?? [];
  const announcement = winnerLine(winnerNames(players));
  const marked = markedSet(tabla?.marked ?? []);
  const calls = lot?.calls ?? [];
  const last = lot?.last_call ?? null;
  const called = calledSet(calls);
  const result = placedResult(
    data?.status,
    current?.id,
    players,
    lot ? PATTERN_COPY[lot.pattern].name : null,
  );

  return (
    <PhoneGameFrame
      title={data?.title}
      status={
        data
          ? `${statusLabel(data.kind, data.status)} · ${statusLine(data.status, !!tabla, calls.length)}`
          : undefined
      }
      statusTestId="loteria-status"
      players={data ? loteriaStripPlayers(rankPlayers(players), { progress: false }) : undefined}
      emptyPlayersText="Players show up here as they get their tablas"
      attrs={{ "data-kind": "loteria", "data-status": data?.status, "data-live": game.live }}
      notice={game.error ? <ApiErrorNotice error={game.error} /> : null}
    >
      <ResultMoment gameId={gameId} personId={current?.id} decision={result} />
      {data ? (
        <>
          <div aria-live="polite" data-testid="loteria-announcement">
            {announcement ? (
              <p className="rounded-2xl bg-card p-4 text-xl font-semibold marquee-glow">
                {announcement}
              </p>
            ) : null}
          </div>

          {!current ? (
            <p className="rounded-xl bg-muted p-4" data-testid="loteria-pick-person">
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

          {current && !tabla && (data.status === "open" || data.status === "live") ? (
            <>
              <ApiErrorNotice error={join.error} />
              <Button
                size="lg"
                data-testid="primary-action"
                className="min-h-14 w-full text-lg"
                disabled={join.isPending}
                onClick={() => join.mutate()}
              >
                Get my tabla
              </Button>
            </>
          ) : null}

          {data.status === "live" || data.status === "ended" ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-card p-4">
              <p className="text-sm text-muted-foreground">Last card</p>
              <CurrentCard cardId={last?.card_id ?? null} variant="phone" testId="loteria-last" />
              <p className="text-base text-muted-foreground" data-testid="loteria-recent">
                {recentCalls(calls).length > 0 ? (
                  <>
                    Before:{" "}
                    {recentCalls(calls).map((c, i) => (
                      <span key={c.seq} className="whitespace-nowrap">
                        {i > 0 ? ", " : ""}
                        <strong className="font-bold text-foreground">{c.name_es}</strong>
                      </span>
                    ))}
                  </>
                ) : (
                  "Cards show up here as the host calls them."
                )}
              </p>
            </div>
          ) : null}

          {tabla ? (
            <>
              <p className="text-sm text-muted-foreground" data-testid="loteria-progress">
                {data.status === "live" || data.status === "ended"
                  ? progressLabel({ missing: tabla.missing, won: tabla.won })
                  : "Your tabla"}
              </p>
              <ul
                className="grid grid-cols-4 gap-2"
                aria-label="Your tabla"
                data-testid="loteria-tabla"
              >
                {tabla.squares.map((cardId, index) => {
                  const card = cardById(cardId);
                  const isMarked = marked.has(index);
                  const isCalled = called.has(cardId);
                  // An uncalled picture stays focusable so a tap can say why.
                  const inactive = !isCalled && !isMarked;
                  return (
                    <li key={`${index}-${cardId}`} className="contents">
                      <button
                        type="button"
                        data-testid="loteria-square"
                        data-index={index}
                        data-card-id={cardId}
                        data-called={isCalled}
                        aria-pressed={isMarked}
                        aria-label={squareLabel(cardId, index, isCalled, isMarked)}
                        aria-disabled={inactive || undefined}
                        disabled={data.status !== "live" || mark.isPending}
                        onClick={() => {
                          if (inactive) {
                            setHint(notCalledMessage(cardId, data.status));
                            return;
                          }
                          if (!isMarked && !canMark(data.status, cardId, called)) return;
                          setHint(null);
                          mark.mutate({ index, marked: !isMarked });
                        }}
                        className={cn(
                          "relative flex aspect-[3/4] min-h-20 flex-col items-center justify-center gap-0.5 rounded-lg border p-1 text-center leading-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                          isMarked
                            ? "border-[var(--accent-cinema)] bg-[var(--accent-cinema)]/20 text-foreground"
                            : "border-foreground/15 bg-card text-foreground",
                          inactive && data.status === "live" && "border-dashed",
                        )}
                      >
                        {isMarked ? (
                          <Check
                            aria-hidden
                            className="absolute top-1 right-1 size-4 text-[var(--accent-cinema)]"
                          />
                        ) : null}
                        <span aria-hidden className="text-4xl leading-none">
                          {card.emoji}
                        </span>
                        <span aria-hidden className="text-[0.7rem] font-semibold sm:text-sm">
                          {card.es}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p
                role="status"
                className="min-h-6 text-sm text-muted-foreground"
                data-testid="loteria-hint"
              >
                {hint}
              </p>
              <ApiErrorNotice error={mark.error} />
              {data.status === "open" ? (
                <>
                  <ApiErrorNotice error={reroll.error} />
                  <Button
                    variant="secondary"
                    size="lg"
                    data-testid="loteria-reroll"
                    className="min-h-14 w-full text-lg"
                    disabled={reroll.isPending}
                    onClick={() => reroll.mutate()}
                  >
                    <Shuffle aria-hidden /> Get another tabla
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
