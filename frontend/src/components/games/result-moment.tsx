"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Confetti } from "@/components/games/confetti";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import {
  hasSeen,
  markSeen,
  namesList,
  type ResultDecision,
  setSoundEnabled,
  soundEnabled,
  whoWonLine,
} from "@/lib/result-moment";

/** A short cheer (rising arpeggio) or a descending "whoop, whoop, whoop". WebAudio, no files. */
function playSound(outcome: ResultDecision["outcome"]): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes =
      outcome === "won"
        ? [
            [523, 0, 0.15],
            [659, 0.15, 0.15],
            [784, 0.3, 0.15],
            [1047, 0.45, 0.4],
          ]
        : [
            [440, 0, 0.3],
            [370, 0.35, 0.3],
            [294, 0.7, 0.6],
          ];
    for (const [freq, at, len] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = outcome === "won" ? "triangle" : "sine";
      const t = ctx.currentTime + at;
      osc.frequency.setValueAtTime(freq, t);
      // A loss slides down within each note: the "whoop".
      if (outcome === "lost") osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t + len);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.05);
    }
    window.setTimeout(() => void ctx.close(), 2000);
  } catch {
    /* sound is never required */
  }
}

/**
 * The win and lose moment on a phone (ADR-0018 amendment 2026-11-26): a full-screen card when the
 * game ends. Winner: "You won!", the pattern or points, a big avatar, confetti. Everyone else who
 * played: a kind "Maybe next time" with three bouncing "whoop" dots and who won. Shown once per
 * person per game on this device (localStorage guard); the game screen keeps its own result line.
 * Escape or the big button closes it; reduced motion gets a still version; sound is opt-in.
 */
export function ResultMoment({
  gameId,
  personId,
  decision,
}: {
  gameId: string;
  personId: string | null | undefined;
  decision: ResultDecision | null;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const key = decision && personId ? `${gameId}:${personId}` : null;
  const open = key !== null && openFor === key;

  const outcome = decision?.outcome;
  useEffect(() => {
    if (!outcome || !personId) return;
    // Deferred a tick so a StrictMode re-run cancels the first pass before it marks anything.
    const timer = window.setTimeout(() => {
      if (hasSeen(gameId, personId)) return;
      markSeen(gameId, personId);
      setOpenFor(`${gameId}:${personId}`);
      const on = soundEnabled();
      setSound(on);
      // Only after the person has tapped this page; browsers block autoplay otherwise.
      const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
        .userActivation?.hasBeenActive;
      if (on && active) playSound(outcome);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [outcome, gameId, personId]);

  useEffect(() => {
    if (!open) return;
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !decision) return null;
  const won = decision.outcome === "won";
  const me = decision.winners.find((w) => w.person_id === personId);
  const others = decision.winners.filter((w) => w.person_id !== personId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="result-moment-title"
      data-testid="result-moment"
      data-outcome={decision.outcome}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
    >
      {won ? <Confetti /> : null}
      <div
        data-testid={won ? "result-won" : "result-lost"}
        className="result-pop relative flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl border border-foreground/15 bg-card p-6 text-center text-foreground shadow-xl"
      >
        <div aria-live="polite" className="flex flex-col items-center gap-3">
          {won ? (
            <>
              {me ? (
                <Avatar
                  emoji={me.avatar_emoji}
                  color={me.color}
                  className="size-28 text-6xl marquee-glow"
                />
              ) : null}
              <h2 id="result-moment-title" className="font-heading text-4xl font-bold">
                You won!
              </h2>
              {decision.detail ? (
                <p className="text-lg text-muted-foreground" data-testid="result-detail">
                  {decision.detail}
                </p>
              ) : null}
              {others.length > 0 ? (
                <p className="text-base text-muted-foreground">Tied with {namesList(others)}.</p>
              ) : null}
            </>
          ) : (
            <>
              <p
                aria-hidden
                className="flex gap-3 text-4xl leading-none"
                data-testid="result-whoop"
              >
                <span className="whoop-dot">•</span>
                <span className="whoop-dot">•</span>
                <span className="whoop-dot">•</span>
              </p>
              <p className="text-sm tracking-widest text-muted-foreground uppercase">
                whoop, whoop, whoop
              </p>
              <h2 id="result-moment-title" className="font-heading text-3xl font-bold">
                Maybe next time
              </h2>
              <p className="flex items-center gap-2 text-lg" data-testid="result-winners">
                {decision.winners.slice(0, 3).map((w) => (
                  <Avatar key={w.person_id} emoji={w.avatar_emoji} color={w.color} size="md" />
                ))}
                <span>{whoWonLine(decision.winners)}</span>
              </p>
              <p className="text-base text-muted-foreground">Great playing. Next round is yours!</p>
            </>
          )}
        </div>
        <Button
          ref={dismissRef}
          size="lg"
          data-testid="result-dismiss"
          className="min-h-14 w-full text-lg"
          onClick={() => setOpenFor(null)}
        >
          {won ? "Yay! Close" : "OK, close"}
        </Button>
        <button
          type="button"
          data-testid="result-sound"
          aria-pressed={sound}
          className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => {
            const next = !sound;
            setSound(next);
            setSoundEnabled(next);
            if (next) playSound(decision.outcome);
          }}
        >
          {sound ? (
            <Volume2 aria-hidden className="size-4" />
          ) : (
            <VolumeX aria-hidden className="size-4" />
          )}
          Sound {sound ? "on" : "off"}
        </button>
      </div>
    </div>
  );
}
