"use client";

import { type ReactNode, useEffect, useState } from "react";

import { Avatar } from "@/components/night/avatar";
import type { ScatterAnswer, ScatterRevealed, ScatterState } from "@/lib/api";
import { answerNote, byCategory, formatClock, pointsLabel, timeFraction } from "@/lib/scatter";
import { LEADERBOARD_TV_MAX, needsResultsPaging, nextPage } from "@/lib/game-layout";
import { cn } from "@/lib/utils";

type Standing = ScatterState["leaderboard"][number];

/** The countdown: digits plus a bar. The bar only animates for people who allow motion. */
export function Countdown({
  seconds,
  duration,
  tv,
}: {
  seconds: number;
  duration: number;
  tv?: boolean;
}) {
  const urgent = seconds > 0 && seconds <= 10;
  return (
    <div className="flex w-full flex-col gap-2" data-testid="scatter-countdown-block">
      <p
        data-testid="scatter-countdown"
        data-seconds={seconds}
        className={cn(
          "font-heading font-semibold tabular-nums",
          tv ? "tv-display" : "text-5xl",
          urgent && "text-destructive",
        )}
      >
        {formatClock(seconds)}
      </p>
      <div
        role="presentation"
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        aria-hidden
      >
        <div
          className="h-full rounded-full bg-foreground/70 motion-safe:transition-[width] motion-safe:duration-300"
          style={{ width: `${timeFraction(seconds, duration) * 100}%` }}
        />
      </div>
    </div>
  );
}

/** The big letter. The cinema accent marks the one thing everyone is looking at. */
export function LetterTile({ letter, tv }: { letter: string; tv?: boolean }) {
  return (
    <p
      data-testid="scatter-letter"
      aria-label={`The letter is ${letter}`}
      className={cn(
        "flex aspect-square items-center justify-center rounded-3xl border border-foreground/10 bg-card font-heading font-bold marquee-glow",
        tv ? "w-[1.4em] text-[5em]" : "w-28 text-7xl",
      )}
    >
      {letter}
    </p>
  );
}

export function Leaderboard({ standings, tv }: { standings: Standing[]; tv?: boolean }) {
  if (standings.length === 0) return null;
  // A TV cannot scroll: a crowd's table shows its top places and says how many more there are.
  const shown = tv ? standings.slice(0, LEADERBOARD_TV_MAX) : standings;
  const more = standings.length - shown.length;
  return (
    <section className="flex w-full flex-col gap-2" aria-label="Leaderboard">
      <h2 className={cn("font-medium", tv ? "tv-body" : "text-lg")}>Leaderboard</h2>
      <ol
        className={cn(
          "flex flex-col gap-2",
          tv && standings.length > 6 && "grid grid-cols-2 gap-[0.5em]",
        )}
      >
        {shown.map((s, i) => (
          <li
            key={s.person_id}
            data-testid="scatter-standing"
            className={cn(
              "flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3",
              tv && "tv-body gap-[0.75em] p-[0.6em]",
            )}
          >
            <span className="w-6 text-center text-muted-foreground tabular-nums">{i + 1}</span>
            <Avatar emoji={s.avatar_emoji} color={s.color} size={tv ? "sm" : "xs"} />
            <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
            <span className="tabular-nums" data-testid="scatter-standing-points">
              {pointsLabel(s.points)}
            </span>
          </li>
        ))}
      </ol>
      {more > 0 ? (
        <p className="tv-small text-muted-foreground" data-testid="scatter-standing-more">
          and {more} more
        </p>
      ) : null}
    </section>
  );
}

/**
 * A revealed round: each category with every answer, who gave it and what it scored. Scores come
 * from the server (derived on every read), never computed here. `action` lets the host reject or
 * re-accept an answer.
 */
export function Results({
  round,
  standings,
  tv,
  action,
}: {
  round: ScatterRevealed;
  standings: Standing[];
  tv?: boolean;
  action?: (answer: ScatterAnswer) => ReactNode;
}) {
  const people = new Map(standings.map((s) => [s.person_id, s]));
  const scores = new Map(round.scores.map((s) => [s.person_id, s.points]));
  const groups = byCategory(round.categories, round.answers);
  const paged = tv === true && needsResultsPaging(round.answers.length);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!paged) return;
    const timer = setInterval(() => setPage((p) => nextPage(p, groups.length)), 9000);
    return () => clearInterval(timer);
  }, [paged, groups.length]);
  const visible = paged ? [groups[page % groups.length]] : groups;
  return (
    <section
      className={cn("flex w-full flex-col gap-4", tv && "grid grid-cols-3 items-start gap-[0.8em]")}
      aria-label={`Round ${round.round_no} answers`}
      data-testid="scatter-results"
      data-round={round.round_no}
    >
      {visible.map(({ category, answers }) => (
        <div
          key={category}
          className={cn("flex flex-col gap-2", paged && "col-span-3")}
          data-testid="scatter-category"
        >
          <h3 className={cn("font-medium", tv ? "tv-small" : "text-base")}>{category}</h3>
          {answers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No answers.</p>
          ) : (
            <ul
              className={cn(
                "flex flex-col gap-2",
                tv && "gap-[0.3em]",
                paged && "grid grid-cols-3",
              )}
            >
              {answers.map((a) => {
                const who = people.get(a.person_id);
                const note = answerNote(a);
                return (
                  <li
                    key={a.answer_id}
                    data-testid="scatter-answer"
                    data-point={a.point}
                    data-verdict={a.verdict ?? ""}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3",
                      tv && "tv-small gap-[0.5em] p-[0.3em]",
                      a.point === 0 && "opacity-70",
                    )}
                  >
                    {who ? <Avatar emoji={who.avatar_emoji} color={who.color} size="xs" /> : null}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block font-medium", a.point === 0 && "line-through")}>
                        {a.text}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {who?.name ?? "Someone"}
                        {note ? ` · ${note}` : ""}
                      </span>
                    </span>
                    <span className="tabular-nums">{pointsLabel(a.point)}</span>
                    {action ? action(a) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      {paged ? (
        <p
          className="tv-small col-span-3 text-center text-muted-foreground"
          data-testid="scatter-page"
        >
          Category {(page % groups.length) + 1} of {groups.length}
        </p>
      ) : null}
      <p
        className={cn("text-sm text-muted-foreground", tv && "col-span-3", paged && "sr-only")}
        data-testid="scatter-round-scores"
      >
        {[...scores.entries()]
          .map(([id, pts]) => `${people.get(id)?.name ?? "Someone"} ${pointsLabel(pts)}`)
          .join(" · ")}
      </p>
    </section>
  );
}
