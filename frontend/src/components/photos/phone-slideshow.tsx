"use client";

import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { PersonAvatar } from "@/components/photos/person-avatar";
import { Button } from "@/components/ui/button";
import { useSlideshow } from "@/hooks/use-slideshow";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { type LiveState } from "@/lib/live";
import { photoAlt } from "@/lib/photos/caption";
import { upcoming } from "@/lib/slideshow";
import { swipeStep } from "@/lib/slideshow-control";

/**
 * "Play slideshow" on a phone (issue #41, 04-frontend.md "Photo drop"): the TV's slideshow, same
 * schedule (useSlideshow → slideshow.ts), full screen and portrait-friendly. Tap the photo to
 * pause or resume, swipe to step; new photos jump the queue live and hidden ones drop out, as on
 * the TV. The screen stays awake while it is open (released on close and while hidden).
 * Members and guests (night-code devices) see the same thing: it reads the same album.
 */
export function PhoneSlideshow({
  sessionId,
  live,
  onClose,
}: {
  sessionId: string;
  live: LiveState;
  onClose: () => void;
}) {
  const { state, now, photos, count, next, prev, pause, onFail } = useSlideshow(sessionId, live);
  const ref = useRef<HTMLDialogElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  useWakeLock();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const current = state.current ? photos.get(state.current) : undefined;
  const nextId = upcoming(state, now);
  const preload = nextId ? photos.get(nextId) : undefined;

  return (
    <dialog
      ref={ref}
      aria-label="Photo slideshow"
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") next();
        else if (event.key === "ArrowLeft") prev();
        else return;
        event.preventDefault();
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-black p-0 text-white backdrop:bg-black"
      data-testid="phone-slideshow"
      data-photo={current?.id}
      data-paused={state.paused}
    >
      <div className="relative flex h-full flex-col">
        <div
          className="relative min-h-0 flex-1 touch-pan-y select-none"
          data-testid="phone-slideshow-stage"
          onPointerDown={(event) => {
            touch.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerCancel={() => {
            touch.current = null;
          }}
          onPointerUp={(event) => {
            const start = touch.current;
            touch.current = null;
            if (!start || !current) return;
            const step = swipeStep(event.clientX - start.x, event.clientY - start.y);
            if (step === 1) next();
            else if (step === -1) prev();
            else pause();
          }}
        >
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element -- presigned bucket URL (ADR-0005)
            <img
              key={current.id}
              src={current.url}
              alt={photoAlt(current)}
              decoding="async"
              referrerPolicy="no-referrer"
              draggable={false}
              onError={() => onFail(current.id)}
              className="phone-slide absolute inset-0 size-full object-contain"
            />
          ) : (
            <p
              className="absolute inset-0 flex items-center justify-center px-8 text-center text-lg text-white/80"
              data-testid="phone-slideshow-empty"
            >
              No photos to show yet. They&apos;ll appear here as people add them.
            </p>
          )}
          {preload ? (
            // The next photo, loaded off screen so the change never waits on the network.
            // eslint-disable-next-line @next/next/no-img-element -- presigned bucket URL (ADR-0005)
            <img
              key={`next-${preload.id}`}
              src={preload.url}
              alt=""
              aria-hidden
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => onFail(preload.id)}
              className="pointer-events-none absolute size-px opacity-0"
            />
          ) : null}
        </div>

        <Button
          variant="secondary"
          size="tap"
          className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-3 px-0 opacity-90"
          onClick={() => ref.current?.close()}
          aria-label="Close slideshow"
        >
          <X aria-hidden />
        </Button>

        <footer className="flex flex-col gap-3 bg-gradient-to-t from-black via-black/90 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {current ? (
            <div className="flex items-center gap-3" data-testid="phone-slideshow-caption">
              <PersonAvatar emoji={current.person_avatar_emoji} color={current.person_color} />
              <p className="min-w-0 flex-1 truncate text-lg font-medium">{current.person_name}</p>
              <p className="text-sm text-white/70" data-testid="phone-slideshow-count">
                {count === 1 ? "1 photo" : `${count} photos`}
              </p>
            </div>
          ) : null}
          <div className="grid grid-cols-3 gap-2">
            <Button
              variant="secondary"
              size="tap"
              onClick={prev}
              disabled={!current}
              aria-label="Previous photo"
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              variant="secondary"
              size="tap"
              onClick={pause}
              disabled={!current}
              aria-label={state.paused ? "Resume slideshow" : "Pause slideshow"}
              data-testid="phone-slideshow-pause"
            >
              {state.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            </Button>
            <Button
              variant="secondary"
              size="tap"
              onClick={next}
              disabled={!current}
              aria-label="Next photo"
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
          {state.paused ? (
            <p role="status" className="text-center text-sm text-white/80">
              Paused. Tap the photo to resume.
            </p>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}
