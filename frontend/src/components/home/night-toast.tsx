"use client";

import { Clapperboard } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAutoMoveCountdown } from "@/hooks/use-auto-move-countdown";
import { markNightSeen } from "@/hooks/use-household-night";
import type { NightSummary } from "@/lib/api";
import { AUTO_MOVE_SECONDS } from "@/lib/auto-move";
import {
  countdownAnnouncement,
  HOME_COPY,
  isOwnNightPath,
  toastTitle,
  toastVisible,
} from "@/lib/home";
import { cn } from "@/lib/utils";

type ToastNight = Pick<NightSummary, "id" | "status" | "title" | "winner">;

/**
 * The new-night toast (guest-home §5 H0c, issue #70), mounted once by `GuestShell` on every
 * signed-in screen. When a night starts that this tab hasn't shown, it says "Movie night started"
 * with **Join** and a 60 s countdown that moves the phone there, plus **Stay here**. It follows the
 * phone across screens (the countdown keeps its second, `useAutoMoveCountdown`) until the guest
 * joins, stays, or is moved; it never shows on that night's own screens.
 *
 * It sits just above the bottom nav (`aboveNav`), never over it, so the tabs stay tappable.
 */
export function NightToast({
  night,
  isNew,
  pathname,
  aboveNav,
}: {
  night: ToastNight | undefined;
  isNew: boolean;
  pathname: string;
  aboveNav: boolean;
}) {
  const own = night !== undefined && isOwnNightPath(pathname, night.id);
  const move = useAutoMoveCountdown(night?.id, isNew && !own);
  const { cancel } = move;

  // On the night's own screens the phone is already there: that counts as shown (no toast on the
  // way back out), and any countdown for it is over.
  const ownId = own ? night.id : undefined;
  useEffect(() => {
    if (!ownId) return;
    cancel();
    markNightSeen(ownId);
  }, [ownId, cancel]);

  const visible = toastVisible({
    pathname,
    nightId: night?.id,
    isNew,
    stayed: move.stayed,
    counting: move.counting,
  });
  const [said, setSaid] = useState("");
  const next = visible ? countdownAnnouncement(said, move) : "";
  if (next !== said) setSaid(next);

  return (
    <>
      {/* Always mounted, so screen readers hear the toast arrive (an empty region, then text). */}
      <span aria-live="polite" className="sr-only" data-testid="handoff-announce">
        {visible && night ? `${headline(night)}. ${said}` : ""}
      </span>
      {visible && night ? (
        <NightToastView
          night={night}
          seconds={move.seconds}
          paused={move.paused}
          aboveNav={aboveNav}
          onJoin={move.join}
          onStay={move.stay}
        />
      ) : null}
    </>
  );
}

function headline(night: ToastNight): string {
  const title = toastTitle(night);
  return title ? `${HOME_COPY.toast.started} · ${title}` : HOME_COPY.toast.started;
}

/** The toast itself, from plain props (unit-tested without a router). */
export function NightToastView({
  night,
  seconds,
  paused,
  aboveNav,
  onJoin,
  onStay,
}: {
  night: ToastNight;
  seconds: number;
  paused: boolean;
  aboveNav: boolean;
  onJoin: () => void;
  onStay: () => void;
}) {
  const title = toastTitle(night);
  return (
    <section
      aria-label={HOME_COPY.toast.label}
      data-testid="night-toast"
      data-toast
      data-night={night.id}
      className={cn(
        // Fixed just above the nav (56px + the safe area), never covering it: the tabs stay usable.
        "fixed inset-x-0 z-40 mx-auto w-full max-w-md px-3",
        aboveNav
          ? "bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px)+0.5rem)]"
          : "bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]",
      )}
    >
      <div className="flex flex-col gap-3 rounded-2xl bg-card p-3 shadow-lg ring-1 ring-cinema/60 motion-safe:animate-in motion-safe:slide-in-from-bottom-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
            <Clapperboard aria-hidden className="size-5 text-cinema" />
          </span>
          <p className="min-w-0 flex-1 text-base leading-snug" data-testid="toast-line">
            {HOME_COPY.toast.started}
            {title ? (
              <>
                {" · "}
                <strong className="break-words">{title}</strong>
              </>
            ) : null}
            <span
              data-testid="handoff-countdown"
              data-seconds={seconds}
              data-paused={paused || undefined}
              className="block text-sm text-muted-foreground tabular-nums"
            >
              {paused ? HOME_COPY.handoff.paused : HOME_COPY.handoff.countdown(seconds)}
            </span>
          </p>
        </div>
        <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-cinema transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
            style={{ width: `${(seconds / AUTO_MOVE_SECONDS) * 100}%` }}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="tap"
            className="flex-1"
            data-testid="handoff-stay"
            onClick={onStay}
          >
            {HOME_COPY.handoff.stay}
          </Button>
          <Button size="tap" className="flex-1" data-testid="toast-join" onClick={onJoin}>
            {HOME_COPY.toast.join}
          </Button>
        </div>
      </div>
    </section>
  );
}
