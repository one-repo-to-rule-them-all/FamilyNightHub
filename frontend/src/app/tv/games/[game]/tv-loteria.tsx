"use client";

import { CurrentCard, LoteriaCalledBoard } from "@/components/games/loteria-parts";
import { Confetti } from "@/components/games/confetti";
import { TvGameFrame } from "@/components/games/tv-game-frame";
import { useLiveGame } from "@/hooks/use-live-game";
import { useWakeLock } from "@/hooks/use-wake-lock";
import {
  loteriaStripPlayers,
  PATTERN_COPY,
  rankPlayers,
  recentCalls,
  winnerLine,
  winnerNames,
} from "@/lib/loteria";

/**
 * /tv/games/[game] for Lotería (ADR-0018 amendment 2026-11-26): the card just called, very large
 * with its Spanish name, the last five before it, the 54-picture called board and who is playing.
 * No per-player progress (it would spoil the suspense; the host panel has it). A winner is the one
 * place the cinema accent is used. Each call and the winner are announced in a polite live region.
 */
export function TvLoteria({ gameId }: { gameId: string }) {
  const game = useLiveGame(gameId);
  useWakeLock();
  const data = game.data;
  const lot = data?.loteria ?? null;
  const players = rankPlayers(lot?.players ?? []);
  const announcement = winnerLine(winnerNames(players));
  const calls = lot?.calls ?? [];
  const last = lot?.last_call ?? null;

  if (game.error) {
    return (
      <p className="tv-title m-auto text-center" data-testid="tv-unpaired">
        This screen can&apos;t reach the game. A host pairs it with{" "}
        <strong>Use this browser as the TV</strong>.
      </p>
    );
  }

  return (
    <TvGameFrame
      title={data?.title ?? "Lotería"}
      subtitle={
        lot ? (
          <span data-testid="tv-loteria-pattern">
            {PATTERN_COPY[lot.pattern].name}: {PATTERN_COPY[lot.pattern].blurb}
          </span>
        ) : null
      }
      banner={
        <div aria-live="polite" className="w-full">
          {announcement ? <Confetti fixed testId="tv-confetti" /> : null}
          {announcement ? (
            <p
              data-testid="tv-loteria-winner"
              className="tv-display rounded-[1em] border border-[var(--accent-cinema)] bg-card p-[0.75em] marquee-glow"
            >
              {announcement}
            </p>
          ) : null}
        </div>
      }
      players={loteriaStripPlayers(players, { progress: false })}
      playerTestId="tv-loteria-player"
      emptyPlayersText="Players show up here as they get their tablas"
      maxWidth="90em"
      attrs={{
        "data-testid": "tv-loteria",
        "data-status": data?.status,
        "data-live": game.live,
        "data-pattern": lot?.pattern,
      }}
    >
      {data?.status === "draft" || data?.status === "open" ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-loteria-lobby">
          {data.status === "draft"
            ? "Getting ready…"
            : `Get your tabla from your phone: Games, then ${data.title}.`}
        </p>
      ) : null}
      {data?.status === "live" || data?.status === "ended" ? (
        <>
          <div className="flex items-center justify-center gap-[2em]">
            <CurrentCard cardId={last?.card_id ?? null} variant="tv" testId="tv-loteria-last" />
            <div>
              <p className="tv-body text-muted-foreground">Before that</p>
              <ol className="tv-body flex flex-col gap-[0.25em]" data-testid="tv-loteria-recent">
                {recentCalls(calls).map((c) => (
                  <li key={c.seq}>
                    <span aria-hidden>{c.emoji} </span>
                    {c.name_es}
                  </li>
                ))}
              </ol>
            </div>
          </div>
          {/* Each call is announced; the board below is not read out card by card. */}
          <p className="sr-only" aria-live="polite" data-testid="tv-loteria-call-announcement">
            {last ? `Card ${calls.length}: ${last.name_es}, ${last.name_en}` : ""}
          </p>
          <LoteriaCalledBoard calls={calls} variant="tv" />
        </>
      ) : null}
      {data?.status === "live" && !last ? (
        <p className="tv-body text-muted-foreground">Waiting for the first card…</p>
      ) : null}
      {data?.status === "ended" && !announcement ? (
        <p className="tv-body text-muted-foreground">That round is over. Thanks for playing.</p>
      ) : null}
    </TvGameFrame>
  );
}
