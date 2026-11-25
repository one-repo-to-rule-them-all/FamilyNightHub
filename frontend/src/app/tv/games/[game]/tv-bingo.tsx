"use client";

import { Check } from "lucide-react";

import { Avatar } from "@/components/night/avatar";
import { useLiveGame } from "@/hooks/use-live-game";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { progressLabel, rankPlayers, WIN_MODE_COPY, winnerLine, winnerNames } from "@/lib/bingo";
import { cn } from "@/lib/utils";

/**
 * /tv/games/[game] for bingo (ADR-0018 slice B): who is playing and how close each card is,
 * never which squares. A winner is the one place the cinema accent is used. Wins are announced
 * politely for screen readers.
 */
export function TvBingo({ gameId }: { gameId: string }) {
  const game = useLiveGame(gameId);
  useWakeLock();
  const data = game.data;
  const bingo = data?.bingo ?? null;
  const players = rankPlayers(bingo?.players ?? []);
  const announcement = winnerLine(winnerNames(players));

  if (game.error) {
    return (
      <p className="tv-title m-auto text-center" data-testid="tv-unpaired">
        This screen can&apos;t reach the game. A host pairs it with{" "}
        <strong>Use this browser as the TV</strong>.
      </p>
    );
  }

  return (
    <div
      className="m-auto flex w-full max-w-[70em] flex-col items-center gap-[1.5em] px-[1em] text-center"
      data-testid="tv-bingo"
      data-status={data?.status}
      data-live={game.live}
    >
      <h1 className="tv-title">{data?.title ?? "Thanksgiving bingo"}</h1>
      {data && bingo ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-bingo-mode">
          {WIN_MODE_COPY[bingo.win_mode].name}: {WIN_MODE_COPY[bingo.win_mode].blurb}
        </p>
      ) : null}
      {data?.status === "draft" || data?.status === "open" ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-bingo-lobby">
          {data.status === "draft"
            ? "Getting ready…"
            : `Get your card from your phone: Games, then ${data.title}.`}
        </p>
      ) : null}
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
      <ul className="grid w-full grid-cols-2 gap-[1em] md:grid-cols-3">
        {players.map((p) => (
          <li
            key={p.person_id}
            data-testid="tv-bingo-player"
            data-won={p.won ? "true" : "false"}
            className={cn(
              "flex items-center gap-[0.75em] rounded-[1em] border bg-card p-[1em] text-left",
              p.won ? "border-[var(--accent-cinema)]" : "border-foreground/10",
            )}
          >
            <Avatar emoji={p.avatar_emoji} color={p.color} className="size-[2.4em] text-[1.4em]" />
            <span className="tv-body min-w-0 flex-1">
              <span className="block font-medium">{p.name}</span>
              <span className="flex items-center gap-[0.35em] text-muted-foreground">
                {p.won ? <Check aria-hidden className="size-[1em]" /> : null}
                {progressLabel(p)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {data?.status === "ended" && !announcement ? (
        <p className="tv-body text-muted-foreground">That round is over. Thanks for playing.</p>
      ) : null}
    </div>
  );
}
