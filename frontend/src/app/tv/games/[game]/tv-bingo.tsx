"use client";

import { CalledBoard } from "@/components/games/called-board";
import { TvGameFrame } from "@/components/games/tv-game-frame";
import { useLiveGame } from "@/hooks/use-live-game";
import { useWakeLock } from "@/hooks/use-wake-lock";
import {
  rankPlayers,
  recentCalls,
  spacedLabel,
  WIN_MODE_COPY,
  winnerLine,
  winnerNames,
} from "@/lib/bingo";
import { bingoStripPlayers } from "@/lib/game-layout";

/**
 * /tv/games/[game] for bingo (ADR-0018 slice B): who is playing and how close each card is,
 * never which squares. A winner is the one place the cinema accent is used. Wins are announced
 * politely for screen readers. Laid out on the TV game template: the players are the footer strip.
 *
 * Classic (host-called) rounds show the last call very large, the called board and the last five
 * calls instead, and no per-player progress (it would spoil the suspense). Each call is announced
 * in a polite live region.
 */
export function TvBingo({ gameId }: { gameId: string }) {
  const game = useLiveGame(gameId);
  useWakeLock();
  const data = game.data;
  const bingo = data?.bingo ?? null;
  const classic = bingo?.mode === "classic";
  const players = rankPlayers(bingo?.players ?? []);
  const announcement = winnerLine(winnerNames(players));
  const calls = bingo?.calls ?? [];
  const last = bingo?.last_call ?? null;

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
      title={data?.title ?? (classic ? "Bingo" : "Thanksgiving bingo")}
      subtitle={
        data && bingo ? (
          <span data-testid="tv-bingo-mode">
            {WIN_MODE_COPY[bingo.win_mode].name}: {WIN_MODE_COPY[bingo.win_mode].blurb}
          </span>
        ) : null
      }
      banner={
        <div aria-live="polite" className="w-full">
          {announcement ? (
            <p
              data-testid="tv-bingo-winner"
              className="tv-display rounded-[1em] border border-[var(--accent-cinema)] bg-card p-[0.75em] marquee-glow"
            >
              {announcement}
            </p>
          ) : null}
        </div>
      }
      players={bingoStripPlayers(players, { progress: !classic })}
      playerTestId="tv-bingo-player"
      emptyPlayersText="Players show up here as they get their cards"
      maxWidth={classic ? "90em" : "70em"}
      attrs={{
        "data-testid": "tv-bingo",
        "data-status": data?.status,
        "data-live": game.live,
        "data-mode": bingo?.mode,
      }}
    >
      {data?.status === "draft" || data?.status === "open" ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-bingo-lobby">
          {data.status === "draft"
            ? "Getting ready…"
            : `Get your card from your phone: Games, then ${data.title}.`}
        </p>
      ) : null}
      {classic && (data?.status === "live" || data?.status === "ended") ? (
        <>
          <div className="flex items-center justify-center gap-[2em]">
            <div>
              <p className="tv-body text-muted-foreground">Last call</p>
              <p
                data-testid="tv-bingo-last-call"
                data-value={last?.value}
                aria-label={last ? `Last call ${last.label}` : "No number called yet"}
                className="font-heading leading-none font-bold tabular-nums"
                style={{ fontSize: "7em" }}
              >
                {last ? spacedLabel(last) : "—"}
              </p>
              {/* Each call is announced; the board below is not read out number by number. */}
              <p className="sr-only" aria-live="polite" data-testid="tv-bingo-call-announcement">
                {last ? `Number ${calls.length}: ${last.label}` : ""}
              </p>
            </div>
            <div>
              <p className="tv-body text-muted-foreground">Before that</p>
              <ol className="tv-title flex gap-[0.5em] tabular-nums" data-testid="tv-bingo-recent">
                {recentCalls(calls).map((c) => (
                  <li key={c.seq}>{c.label}</li>
                ))}
              </ol>
            </div>
          </div>
          <CalledBoard calls={calls} variant="tv" />
        </>
      ) : null}
      {!classic && data?.status === "live" && !announcement ? (
        <p className="tv-body text-muted-foreground">Marking squares… first line wins.</p>
      ) : null}
      {classic && data?.status === "live" && !last ? (
        <p className="tv-body text-muted-foreground">Waiting for the first number…</p>
      ) : null}
      {data?.status === "ended" && !announcement ? (
        <p className="tv-body text-muted-foreground">That round is over. Thanks for playing.</p>
      ) : null}
    </TvGameFrame>
  );
}
