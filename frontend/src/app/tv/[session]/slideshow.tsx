"use client";

import { Pause } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar } from "@/components/night/avatar";
import { useSlideshow } from "@/hooks/use-slideshow";
import { type Night } from "@/lib/api";
import { type LiveState } from "@/lib/live";
import { nightCodeIsLive, recallNightCode } from "@/lib/night-code-handoff";
import { type AlbumPhoto } from "@/lib/photos/album";
import { photoAlt } from "@/lib/photos/caption";
import { type SlideshowState, upcoming } from "@/lib/slideshow";
import { cn } from "@/lib/utils";

/**
 * /tv/[session] once the night is `tonight` or `closed` (04-frontend.md "TV"): a full-screen
 * slideshow of the album, or, until a photo can be shown, a prompt to drop photos.
 * Remote/keyboard: ← → step, space (or OK / play-pause) pauses and resumes. The schedule and its
 * album live in useSlideshow, shared with the phone's "Play slideshow".
 */
export function TvSlideshow({ night, live }: { night: Night; live: LiveState }) {
  const { state, now, photos, count, next, prev, pause, onFail } = useSlideshow(night.id, live);

  const showing = state.current !== null;
  useEffect(() => {
    if (!showing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a")) return;
      if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") prev();
      else if ([" ", "Enter", "MediaPlayPause"].includes(event.key)) pause();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showing, next, prev, pause]);

  // The photo that was on screen stays until the new one has loaded, then they crossfade.
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const [lastCurrent, setLastCurrent] = useState<string | null>(null);
  if (lastCurrent !== state.current) {
    setOutgoing(lastCurrent);
    setLastCurrent(state.current);
  }
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());

  const current = state.current ? photos.get(state.current) : undefined;
  if (!current) {
    return <DropPrompt night={night} count={count} />;
  }

  const nextId = upcoming(state, now);
  const outId = outgoing && outgoing !== current.id && photos.has(outgoing) ? outgoing : null;
  // At most MAX_CONCURRENT_LOADS (2) images are ever loading: the outgoing one is already loaded.
  const layers: { photo: AlbumPhoto; role: "current" | "outgoing" | "next" }[] = [];
  if (outId) layers.push({ photo: photos.get(outId)!, role: "outgoing" });
  layers.push({ photo: current, role: "current" });
  if (nextId && nextId !== outId) layers.push({ photo: photos.get(nextId)!, role: "next" });

  return (
    <section
      aria-label="Photo slideshow"
      aria-roledescription="slideshow"
      data-testid="tv-slideshow"
      data-photo={current.id}
      data-paused={state.paused}
      className="fixed inset-0 z-10 overflow-hidden bg-black"
    >
      {layers.map(({ photo, role }) => (
        // eslint-disable-next-line @next/next/no-img-element -- presigned bucket URL, no optimiser
        <img
          key={photo.id}
          src={photo.url}
          alt={role === "current" ? photoAlt(photo) : ""}
          aria-hidden={role === "current" ? undefined : true}
          data-role={role}
          data-pan={order(state, photo.id) % 2 === 0 ? "a" : "b"}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setLoaded((s) => (s.has(photo.id) ? s : new Set(s).add(photo.id)))}
          onError={() => onFail(photo.id)}
          className={cn(
            "tv-slide absolute inset-0 size-full object-contain",
            role !== "next" && "tv-pan",
            role === "current" ? "z-[2]" : role === "outgoing" ? "z-[1]" : "z-0",
          )}
          style={{
            opacity:
              role === "current"
                ? Number(loaded.has(photo.id))
                : role === "outgoing"
                  ? Number(!loaded.has(current.id))
                  : 0,
          }}
        />
      ))}
      <Caption photo={current} count={count} />
      {state.paused ? (
        <p
          role="status"
          data-testid="tv-paused"
          className="tv-body absolute top-[1.2em] left-[1.2em] z-[3] flex items-center gap-[0.4em] rounded-full bg-black/70 px-[0.9em] py-[0.35em] text-white"
        >
          <Pause aria-hidden className="size-[1em] fill-current" />
          Paused
        </p>
      ) : null}
    </section>
  );
}

function order(state: SlideshowState, id: string): number {
  return state.order.indexOf(id);
}

function Caption({ photo, count }: { photo: AlbumPhoto; count: number }) {
  const reactions = photo.reactions.filter((r) => r.count > 0);
  return (
    <div className="absolute inset-x-0 bottom-0 z-[3] flex items-end justify-between gap-[1em] bg-gradient-to-t from-black/85 via-black/45 to-transparent px-[2.5em] pt-[4em] pb-[1.6em] text-white">
      <div className="flex items-center gap-[0.7em]" data-testid="tv-caption">
        <Avatar
          emoji={photo.person_avatar_emoji}
          color={photo.person_color}
          className="size-[2.6em] text-[1.5em]"
        />
        <span className="tv-title" data-testid="tv-caption-name">
          {photo.person_name}
        </span>
        {reactions.length > 0 ? (
          <ul className="ml-[0.6em] flex gap-[0.8em]" aria-label="Reactions">
            {reactions.map((r) => (
              <li key={r.emoji} className="tv-body" aria-label={`${r.emoji} ${r.count}`}>
                <span aria-hidden>
                  {r.emoji} {r.count}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="tv-body text-white/80" data-testid="tv-photo-count">
        {count === 1 ? "1 photo" : `${count} photos`}
      </p>
    </div>
  );
}

/**
 * Nothing to show yet (or the host pressed Stop): point everyone at their phones, with the code
 * if this TV knows it.
 */
export function DropPrompt({
  night,
  count,
  held = false,
}: {
  night: Night;
  count: number;
  held?: boolean;
}) {
  const [code] = useState(() => (nightCodeIsLive(night.status) ? recallNightCode(night.id) : null));
  return (
    <section
      aria-labelledby="tv-drop"
      data-testid="tv-photo-idle"
      data-held={held}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[1.2em] text-center"
    >
      <h2 id="tv-drop" className="tv-display">
        Drop your photos from your phone
      </h2>
      <p className="tv-body text-muted-foreground">
        {held
          ? "Open tonight on your phone and add them to the album. The host will start the slideshow."
          : "Open tonight on your phone and add them to the album. They’ll play here."}
      </p>
      {code ? (
        <p className="tv-body text-muted-foreground">
          New phone? Scan the fridge QR, then enter{" "}
          <span
            className="tv-code block pt-[0.3em] font-mono text-foreground"
            data-testid="tv-idle-code"
          >
            {code}
          </span>
        </p>
      ) : null}
      {count > 0 ? (
        <p className="tv-body" data-testid="tv-photo-count" aria-live="polite">
          {count === 1 ? "1 photo so far" : `${count} photos so far`}
        </p>
      ) : null}
    </section>
  );
}
