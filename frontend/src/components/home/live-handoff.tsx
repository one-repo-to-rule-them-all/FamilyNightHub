"use client";

import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Poster } from "@/components/poster";
import { Button, buttonVariants } from "@/components/ui/button";
import { markNightSeen } from "@/hooks/use-household-night";
import { useAutoMoveCountdown } from "@/hooks/use-auto-move-countdown";
import type { NightSummary } from "@/lib/api";
import { AUTO_MOVE_SECONDS } from "@/lib/auto-move";
import { countdownAnnouncement, handoffLine, HOME_COPY, nightHref } from "@/lib/home";
import { cn } from "@/lib/utils";

type HandoffNight = Pick<NightSummary, "id" | "status" | "winner">;

/**
 * The live hand-off (guest-home §5 H0h, H0c): "a movie night is on" at the top of a shell screen,
 * with **Go to tonight's movie night** as the screen's one primary. With `countdown` (That's a wrap
 * and the recap only) it also moves the phone there after 60 s unless **Stay here** is tapped; the
 * countdown pauses during an upload, an open dialog or a hidden page (`useAutoMoveCountdown`).
 */
export function LiveHandoff({
  night,
  countdown = false,
  primary = true,
}: {
  night: HandoffNight;
  countdown?: boolean;
  primary?: boolean;
}) {
  const move = useAutoMoveCountdown(night.id, countdown);
  const showCountdown = countdown && !move.stayed;
  const [said, setSaid] = useState("");
  const next = showCountdown ? countdownAnnouncement(said, move) : said;
  if (next !== said) setSaid(next);

  return (
    <HandoffCard
      night={night}
      primary={primary}
      countdown={showCountdown ? { seconds: move.seconds, paused: move.paused } : null}
      announcement={said}
      onGo={() => markNightSeen(night.id)}
      onStay={move.stay}
    />
  );
}

/** The card itself, from plain props (unit-tested without a router). */
export function HandoffCard({
  night,
  primary,
  countdown,
  announcement,
  onGo,
  onStay,
}: {
  night: HandoffNight;
  primary: boolean;
  countdown: { seconds: number; paused: boolean } | null;
  announcement: string;
  onGo: () => void;
  onStay: () => void;
}) {
  const movie = night.status === "draft" ? null : night.winner;
  return (
    <section
      aria-label={HOME_COPY.nav.live}
      data-testid="live-handoff"
      data-night={night.id}
      className="flex flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-cinema/50"
    >
      <div className="flex items-center gap-3">
        {movie && night.status !== "voting" ? (
          <Poster title={movie.title} posterPath={movie.poster_path} className="w-12 shrink-0" />
        ) : (
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-muted">
            <Clapperboard aria-hidden className="size-6 text-cinema" />
          </span>
        )}
        <p className="text-lg leading-snug" data-testid="handoff-line">
          {handoffLine(night.status)}
          {night.status === "tonight" && movie ? (
            <>
              {" "}
              <strong>{movie.title}</strong>
            </>
          ) : null}
        </p>
      </div>
      <Link
        href={nightHref(night.id)}
        onClick={onGo}
        data-testid={primary ? "primary-action" : "handoff-go"}
        className={cn(
          buttonVariants({ variant: primary ? "default" : "secondary", size: "tap" }),
          "w-full",
        )}
      >
        {HOME_COPY.handoff.go}
      </Link>
      {countdown ? (
        <>
          <div className="flex flex-col gap-1.5">
            <p
              data-testid="handoff-countdown"
              data-seconds={countdown.seconds}
              data-paused={countdown.paused || undefined}
              className="text-center text-base text-muted-foreground tabular-nums"
            >
              {countdown.paused
                ? HOME_COPY.handoff.paused
                : HOME_COPY.handoff.countdown(countdown.seconds)}
            </p>
            <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-cinema transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
                style={{ width: `${(countdown.seconds / AUTO_MOVE_SECONDS) * 100}%` }}
              />
            </div>
          </div>
          <Button
            variant="secondary"
            size="tap"
            className="w-full"
            data-testid="handoff-stay"
            onClick={onStay}
          >
            {HOME_COPY.handoff.stay}
          </Button>
        </>
      ) : null}
      <span aria-live="polite" className="sr-only" data-testid="handoff-announce">
        {announcement}
      </span>
    </section>
  );
}
