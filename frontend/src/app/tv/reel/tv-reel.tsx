"use client";

import { useSearchParams } from "next/navigation";

import { TvGameFrame } from "@/components/games/tv-game-frame";
import { Avatar } from "@/components/night/avatar";
import { useWakeLock } from "@/hooks/use-wake-lock";
import type { StripPlayer } from "@/lib/game-layout";
import { authorLine } from "@/lib/games";
import { parseWindow, type ReelItem, reelProgress, slideSummary, winnerHeadline } from "@/lib/reel";

import { useReel } from "./use-reel";

function people(item: ReelItem) {
  return [
    ...(item.author ? [item.author] : []),
    ...item.winners,
    ...item.standings.map((s) => s.person),
    ...(item.photo_by ? [item.photo_by] : []),
  ];
}

/** The people behind the slides, for the footer strip (those on the current slide stand out). */
function stripFor(items: readonly ReelItem[], current: ReelItem | null): StripPlayer[] {
  const onShow = new Set(current ? people(current).map((p) => p.person_id) : []);
  const seen = new Map<string, StripPlayer>();
  for (const item of items) {
    for (const p of people(item)) {
      if (!seen.has(p.person_id)) {
        seen.set(p.person_id, {
          id: p.person_id,
          name: p.name,
          emoji: p.avatar_emoji,
          color: p.color,
          highlight: onShow.has(p.person_id),
        });
      }
    }
  }
  return [...seen.values()];
}

const CARD =
  "flex w-full flex-col items-center gap-[0.75em] rounded-[1em] border border-foreground/10 bg-card p-[1.5em] marquee-glow motion-safe:animate-in motion-safe:duration-700 motion-safe:fade-in";

function Slide({ item }: { item: ReelItem }) {
  if (item.kind === "quote") {
    return (
      <figure key={item.id} data-testid="reel-quote" className={CARD}>
        <blockquote className="tv-display">{item.body}</blockquote>
        <figcaption className="tv-body flex items-center gap-[0.5em] text-muted-foreground">
          {item.author ? (
            <Avatar
              emoji={item.author.avatar_emoji}
              color={item.author.color}
              className="size-[1.6em] text-[1em]"
            />
          ) : null}
          {authorLine(item.author ?? null)}
          {item.game_title ? <span aria-hidden>·</span> : null}
          {item.game_title}
        </figcaption>
      </figure>
    );
  }
  if (item.kind === "winner") {
    return (
      <div key={item.id} data-testid="reel-winner" className={CARD}>
        <p className="tv-body text-muted-foreground">
          {item.game_title}
          {item.label ? ` · ${item.label}` : ""}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-[0.5em]">
          {item.winners.map((w) => (
            <Avatar
              key={w.person_id}
              emoji={w.avatar_emoji}
              color={w.color}
              className="size-[2.4em] text-[1em]"
            />
          ))}
        </div>
        <p className="tv-headline">{winnerHeadline(item)}</p>
        {item.points ? <p className="tv-body text-muted-foreground">{item.points} points</p> : null}
      </div>
    );
  }
  if (item.kind === "leaderboard") {
    return (
      <div key={item.id} data-testid="reel-leaderboard" className={CARD}>
        <p className="tv-body text-muted-foreground">
          {item.game_title} · {item.final ? "Final scores" : "Scores so far"}
        </p>
        <ol className="tv-title flex w-full max-w-[28em] flex-col gap-[0.3em] text-left">
          {item.standings.map((s, i) => (
            <li key={s.person.person_id} className="flex items-center gap-[0.5em]">
              <span className="w-[1.2em] text-muted-foreground">{i + 1}</span>
              <Avatar
                emoji={s.person.avatar_emoji}
                color={s.person.color}
                className="size-[1.2em] text-[1em]"
              />
              <span className="flex-1 truncate">{s.person.name}</span>
              <span>{s.points}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <figure
      key={item.id}
      data-testid="reel-photo"
      className="flex w-full flex-col items-center gap-[0.5em]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL */}
      <img
        src={item.photo_url ?? ""}
        alt={item.photo_by ? `A photo from ${item.photo_by.name}` : "A photo from tonight"}
        className="max-h-[55dvh] w-auto max-w-full rounded-[1em] object-contain marquee-glow motion-safe:animate-in motion-safe:duration-700 motion-safe:fade-in"
      />
      {item.photo_by ? (
        <figcaption className="tv-body text-muted-foreground">From {item.photo_by.name}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * /tv/reel (ADR-0018 amendment "Night reel"): the night's quotes, winners, scores and photos,
 * cycling by themselves in the server's random order, all evening, with no clicking. `?window=all`
 * is everything ever. Moderation is the server's job: a hidden note or photo is never in the list.
 */
export function TvReel() {
  const window = parseWindow(useSearchParams().get("window"));
  const { reel, index, count, isError, error } = useReel(window);
  useWakeLock();

  if (error?.status === 401) {
    return (
      <p className="tv-title m-auto text-center" data-testid="tv-unpaired">
        This screen isn&apos;t paired yet. A host pairs it with{" "}
        <strong>Use this browser as the TV</strong>.
      </p>
    );
  }
  const items = reel?.items ?? [];
  const current = items[index] ?? null;

  return (
    <TvGameFrame
      title="Family Night reel"
      subtitle={window === "all" ? "Every night so far" : "Tonight"}
      players={stripFor(items, current)}
      emptyPlayersText="Quotes, winners and photos from tonight show up here"
      maxWidth="64em"
      attrs={{
        "data-testid": "tv-reel",
        "data-window": window,
        "data-live": isError ? "reconnecting" : reel ? "ready" : "connecting",
        "data-count": String(count),
      }}
    >
      {/* Slides change every few seconds, so the region is polite and the summary is short. */}
      <div aria-live="polite" className="w-full" data-testid="reel-stage">
        {current ? (
          <>
            <Slide item={current} />
            <span className="sr-only">{slideSummary(current)}</span>
          </>
        ) : reel ? (
          <p className="tv-body text-muted-foreground" data-testid="reel-empty">
            Nothing to show yet. Quotes, winners and photos appear here as the night goes on.
          </p>
        ) : (
          <p className="tv-body text-muted-foreground">Getting the reel ready…</p>
        )}
      </div>
      {count > 0 ? (
        <p className="tv-body text-muted-foreground" data-testid="reel-progress" data-index={index}>
          {reelProgress(index, count)}
        </p>
      ) : null}
    </TvGameFrame>
  );
}
