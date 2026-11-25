"use client";

import { useMemo, useState } from "react";

import { TvGameFrame } from "@/components/games/tv-game-frame";
import { Avatar } from "@/components/night/avatar";
import { useJarCycle } from "@/hooks/use-jar-cycle";
import { useLiveGame } from "@/hooks/use-live-game";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { jarStripPlayers } from "@/lib/game-layout";
import { authorLine, jarProgress } from "@/lib/games";
import { cycleCounter } from "@/lib/jar-cycle";

/**
 * /tv/games/[game] for the Gratitude Jar (ADR-0018): while notes are being collected the TV shows
 * the count, then each note as the host reveals it, large and alone. The snapshot never holds an
 * unrevealed note, so nothing here can leak one. The note is announced politely for screen readers.
 * Laid out on the TV game template; the footer strip is the people behind revealed notes.
 */
export function TvJar({ gameId }: { gameId: string }) {
  const game = useLiveGame(gameId);
  useWakeLock();
  const data = game.data;
  const ended = data?.status === "ended";
  // An ended jar keeps showing its notes (night reel amendment): a manual jar has no cycle, so it
  // gets a local one, and a paused or anchored cycle runs on once the game is over.
  const [mountedAt] = useState(() => new Date().toISOString());
  // Memoised: the cycle hook reads the clock offset each time its `cycle` object changes.
  const snapshotJar = data?.jar ?? null;
  const jar = useMemo(() => {
    if (!snapshotJar || !ended || snapshotJar.revealed.length === 0) return snapshotJar;
    return {
      ...snapshotJar,
      mode: "cycle" as const,
      cycle: {
        anchor_at: snapshotJar.cycle?.anchor_at ?? new Date(0).toISOString(),
        server_now: snapshotJar.cycle?.server_now ?? mountedAt,
        dwell_seconds: snapshotJar.cycle?.dwell_seconds ?? 12,
        paused_index: null,
      },
    };
  }, [snapshotJar, ended, mountedAt]);
  const cycling = jar?.mode === "cycle";
  const cycle = useJarCycle(jar);
  const note = cycling
    ? data?.status === "live" || ended
      ? (jar?.revealed[cycle.index] ?? null)
      : null
    : (jar?.current ?? null);

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
      title={data?.title ?? "Gratitude jar"}
      players={jarStripPlayers(jar?.revealed ?? [])}
      emptyPlayersText="Names appear here as notes are revealed"
      maxWidth="60em"
      attrs={{
        "data-testid": "tv-jar",
        "data-status": data?.status,
        "data-live": game.live,
      }}
    >
      {data?.status === "open" ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-jar-collecting">
          Add a note from your phone: Games, then {data.title}.
          <span className="mt-[0.5em] block" data-testid="tv-jar-count">
            {jar ? jarProgress(jar.note_count, jar.revealed_count) : ""}
          </span>
        </p>
      ) : null}
      {/* A manual reveal is announced; a cycling note every few seconds would be noise. */}
      <div aria-live={cycling ? "off" : "polite"} className="w-full">
        {note ? (
          <figure
            key={note.id}
            data-testid="tv-note"
            className="flex flex-col items-center gap-[0.75em] rounded-[1em] border border-foreground/10 bg-card p-[1.5em] marquee-glow motion-safe:animate-in motion-safe:duration-700 motion-safe:fade-in"
          >
            <blockquote className="tv-display">{note.body}</blockquote>
            <figcaption className="tv-body flex items-center gap-[0.5em] text-muted-foreground">
              {note.author ? (
                <Avatar
                  emoji={note.author.avatar_emoji}
                  color={note.author.color}
                  className="size-[1.6em] text-[1em]"
                />
              ) : null}
              {authorLine(note.author)}
            </figcaption>
          </figure>
        ) : data?.status === "live" && !cycling ? (
          <p className="tv-body text-muted-foreground">Here comes the first note…</p>
        ) : null}
      </div>
      {(data?.status === "live" || ended) && jar && cycling ? (
        <p
          className="tv-body flex items-center gap-[0.75em] text-muted-foreground"
          data-testid="tv-jar-progress"
        >
          {cycleCounter(cycle.index, cycle.count)}
          {cycle.paused ? (
            <span
              data-testid="tv-jar-paused"
              className="rounded-full bg-muted px-[0.75em] py-[0.15em] text-foreground"
            >
              Paused
            </span>
          ) : null}
        </p>
      ) : data?.status === "live" && jar ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-jar-progress">
          {jarProgress(jar.note_count, jar.revealed_count)}
        </p>
      ) : null}
      {ended ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-jar-ended">
          That is every note. Thank you, everyone.
        </p>
      ) : null}
    </TvGameFrame>
  );
}
