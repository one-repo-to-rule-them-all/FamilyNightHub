"use client";

import { Clapperboard } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { useAutoMoveCountdown } from "@/hooks/use-auto-move-countdown";
import { markNightSeen } from "@/hooks/use-household-night";
import type { NightSummary } from "@/lib/api";
import { AUTO_MOVE_SECONDS } from "@/lib/auto-move";
import {
  countdownAnnouncement,
  HOME_COPY,
  isOwnNightPath,
  readSeenNight,
  toastTitle,
  toastVisible,
} from "@/lib/home";
import { cn } from "@/lib/utils";

type ToastNight = Pick<NightSummary, "id" | "status" | "title" | "winner">;

/**
 * Drafts this page load has shown the "being set up" toast for, and the ones hidden with OK. Kept
 * outside React so they survive navigation (every page mounts its own shell). A draft the phone saw
 * keeps the full toast coming when voting opens, even if setup ran past the 10-minute "new" window;
 * OK hides only the setup phase, never the toast that voting brings.
 */
const setupSeen = new Set<string>();
const setupHidden = new Set<string>();
const setupListeners = new Set<() => void>();
let setupVersion = 0;

function touchSetup(): void {
  setupVersion += 1;
  for (const listener of setupListeners) listener();
}

function subscribeSetup(listener: () => void): () => void {
  setupListeners.add(listener);
  return () => setupListeners.delete(listener);
}

/** For tests: forget the drafts seen and hidden, as a fresh page load would. */
export function resetSetupForTests(): void {
  setupSeen.clear();
  setupHidden.clear();
  touchSetup();
}

/**
 * The new-night toast (guest-home §5 H0c, issue #70), mounted once by `GuestShell` on every
 * signed-in screen. When a night starts that this tab hasn't shown, it says "Movie night started"
 * with **Join** and a 60 s countdown that moves the phone there, plus **Stay here**. It follows the
 * phone across screens (the countdown keeps its second, `useAutoMoveCountdown`) until the guest
 * joins, stays, or is moved; it never shows on that night's own screens.
 *
 * While the night is still a `draft` (the host is building the shortlist) there is nothing to join
 * yet, so it only says the night is being set up: no Join, no countdown, an OK to hide it. When
 * voting opens it becomes the full toast. That is the #70 Join bug: a phone sent to a night still in
 * draft found nothing to do there, so Join (and the auto-move) seemed to go nowhere.
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
  useSyncExternalStore(
    subscribeSetup,
    () => setupVersion,
    () => 0,
  );
  const own = night !== undefined && isOwnNightPath(pathname, night.id);
  const draft = night?.status === "draft";
  // A draft seen here keeps it "new" past the 10-minute window, but never once the phone has been
  // to the night (joined, moved, or opened it): `fnh.seenNight` always wins.
  const eligible =
    isNew || (night !== undefined && setupSeen.has(night.id) && readSeenNight() !== night.id);
  const move = useAutoMoveCountdown(night?.id, eligible && !own && !draft);
  const { cancel } = move;

  // On the night's own screens the phone is already there: that counts as shown (no toast on the
  // way back out), and any countdown for it is over.
  const ownId = own ? night.id : undefined;
  useEffect(() => {
    if (!ownId) return;
    cancel();
    markNightSeen(ownId);
  }, [ownId, cancel]);

  const visible =
    toastVisible({
      pathname,
      nightId: night?.id,
      isNew: eligible,
      stayed: move.stayed,
      counting: move.counting,
    }) && !(draft && setupHidden.has(night.id));

  // Remember a draft once its setup toast has shown, for when voting opens.
  const setupId = visible && draft ? night.id : undefined;
  useEffect(() => {
    if (!setupId || setupSeen.has(setupId)) return;
    setupSeen.add(setupId);
    touchSetup();
  }, [setupId]);

  const [said, setSaid] = useState("");
  const next = visible && !draft ? countdownAnnouncement(said, move) : "";
  if (next !== said) setSaid(next);

  return (
    <>
      {/* Always mounted, so screen readers hear the toast arrive (an empty region, then text). */}
      <span aria-live="polite" className="sr-only" data-testid="handoff-announce">
        {visible && night
          ? draft
            ? `${HOME_COPY.toast.setup}. ${HOME_COPY.toast.setupBody}`
            : `${headline(night)}. ${said}`
          : ""}
      </span>
      {visible && night && draft ? (
        <SetupToastView
          night={night}
          aboveNav={aboveNav}
          onHide={() => {
            setupHidden.add(night.id);
            touchSetup();
          }}
        />
      ) : visible && night ? (
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

/** The fixed frame both toasts share: just above the nav (56px + the safe area), never over it. */
function ToastFrame({
  night,
  phase,
  aboveNav,
  children,
}: {
  night: ToastNight;
  phase: "setup" | "started";
  aboveNav: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={HOME_COPY.toast.label}
      data-testid="night-toast"
      data-toast
      data-night={night.id}
      data-phase={phase}
      className={cn(
        "fixed inset-x-0 z-40 mx-auto w-full max-w-md px-3",
        aboveNav
          ? "bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px)+0.5rem)]"
          : "bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]",
      )}
    >
      <div className="flex flex-col gap-3 rounded-2xl bg-card p-3 shadow-lg ring-1 ring-cinema/60 motion-safe:animate-in motion-safe:slide-in-from-bottom-4">
        {children}
      </div>
    </section>
  );
}

function ToastIcon() {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
      <Clapperboard aria-hidden className="size-5 text-cinema" />
    </span>
  );
}

/** A draft night: being set up, nothing to join yet (no Join, no countdown). */
export function SetupToastView({
  night,
  aboveNav,
  onHide,
}: {
  night: ToastNight;
  aboveNav: boolean;
  onHide: () => void;
}) {
  return (
    <ToastFrame night={night} phase="setup" aboveNav={aboveNav}>
      <div className="flex items-center gap-3">
        <ToastIcon />
        <p className="min-w-0 flex-1 text-base leading-snug" data-testid="toast-line">
          {HOME_COPY.toast.setup}
          <span className="block text-sm text-muted-foreground">{HOME_COPY.toast.setupBody}</span>
        </p>
        <Button variant="secondary" size="lg" data-testid="toast-hide" onClick={onHide}>
          {HOME_COPY.toast.ok}
        </Button>
      </div>
    </ToastFrame>
  );
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
    <ToastFrame night={night} phase="started" aboveNav={aboveNav}>
      <div className="flex items-start gap-3">
        <ToastIcon />
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
    </ToastFrame>
  );
}
