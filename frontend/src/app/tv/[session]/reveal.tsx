"use client";

import { Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Poster } from "@/components/night/poster";
import { usePrefersReducedMotion } from "@/hooks/use-media";
import type { Night } from "@/lib/api";
import { revealSequence } from "@/lib/reveal";
import { cn } from "@/lib/utils";

/**
 * The reveal (ADR-0006): a cosmetic spin over the shortlist that always lands on the stored
 * winner. Under prefers-reduced-motion (or when the night was already revealed before this screen
 * opened it, `animate` false) it shows the winner straight away.
 */
export function Reveal({ night, animate }: { night: Night; animate: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const winnerId = night.result?.winner_option_id ?? "";
  const optionKey = night.options.map((o) => o.id).join(",");
  const frames = useMemo(
    () =>
      revealSequence(optionKey ? optionKey.split(",") : [], winnerId, {
        reducedMotion: reducedMotion || !animate,
      }),
    [optionKey, winnerId, reducedMotion, animate],
  );
  const [step, setStep] = useState(0);
  const last = Math.max(0, frames.length - 1);
  const at = Math.min(step, last);

  useEffect(() => {
    if (at >= last) return;
    const timer = window.setTimeout(() => setStep(at + 1), frames[at].delayMs);
    return () => window.clearTimeout(timer);
  }, [at, last, frames]);

  const winner = night.options.find((o) => o.id === winnerId);
  if (!winner) return null;
  const landed = at >= last;
  const highlighted = frames[at]?.optionId ?? winnerId;

  if (!landed) {
    return (
      <section aria-label="Revealing the winner" className="flex flex-1 flex-col gap-[1.5em]">
        <p className="tv-display text-center" role="status">
          And tonight&apos;s movie is…
        </p>
        <ul
          className="flex flex-1 items-center justify-center gap-[1.2em]"
          data-testid="tv-spinner"
        >
          {night.options.map((option) => (
            <li
              key={option.id}
              className={cn(
                "w-[9em] transition-transform duration-100",
                option.id === highlighted ? "scale-110 rounded-lg marquee-glow" : "opacity-40",
              )}
            >
              <Poster title={option.title} posterPath={option.poster_path} />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="tv-winner-title"
      className="flex flex-1 items-center justify-center gap-[3em]"
      data-testid="tv-winner"
    >
      <Poster
        title={winner.title}
        posterPath={winner.poster_path}
        width="w500"
        className="w-[16em] marquee-glow"
      />
      <div className="flex max-w-[28em] flex-col gap-[0.6em]" role="status">
        <p className="tv-body flex items-center gap-[0.4em] text-cinema">
          <Trophy aria-hidden className="size-[1.2em]" /> Tonight&apos;s movie
        </p>
        <h2 id="tv-winner-title" className="tv-display">
          {winner.title}
        </h2>
        {winner.year ? <p className="tv-title text-muted-foreground">{winner.year}</p> : null}
        <p className="tv-body text-muted-foreground">
          {night.result?.ballot_count ?? 0} {night.result?.ballot_count === 1 ? "vote" : "votes"}{" "}
          counted
        </p>
      </div>
    </section>
  );
}
