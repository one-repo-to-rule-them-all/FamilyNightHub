"use client";

import { useQuery } from "@tanstack/react-query";
import { Pause } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";

import { Avatar } from "@/components/night/avatar";
import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError, type Night } from "@/lib/api";
import { type LiveState, pollWhileDown } from "@/lib/live";
import { nightCodeIsLive, recallNightCode } from "@/lib/night-code-handoff";
import { ALBUM_REFRESH_MS, type AlbumPhoto, keepFreshUrls, URL_REUSE_MS } from "@/lib/photos/album";
import {
  advance,
  back,
  fail,
  failedIds,
  initialSlideshow,
  playable,
  refreshDue,
  type SlideshowState,
  sync,
  tick,
  togglePause,
  upcoming,
} from "@/lib/slideshow";
import { cn } from "@/lib/utils";

/**
 * The night's album for the TV. Keyed under ["night", id] so every live hint (photo_added,
 * status_changed, a reconnect) refetches it with the snapshot (useLiveSession invalidates by
 * prefix). It also refetches on its own: every ALBUM_REFRESH_MS while the stream is up (hide
 * publishes no event, so this is how a hidden photo leaves), every POLL_MS while it's down.
 * album.ts reuses URLs younger than URL_REUSE_MS, except for photos whose image failed.
 */
function useSlideshowAlbum(sessionId: string, live: LiveState, failed: { current: Set<string> }) {
  return useQuery<AlbumPhoto[], ApiError>({
    queryKey: [...nightKey(sessionId), "slideshow"],
    queryFn: async () => {
      const photos = await api.photos(sessionId);
      const mintedAt = Date.now();
      return photos.map((p) => ({ ...p, urlsMintedAt: mintedAt }));
    },
    refetchInterval: pollWhileDown(live) || ALBUM_REFRESH_MS,
    gcTime: URL_REUSE_MS,
    retry: 1,
    structuralSharing: (previous, next) =>
      keepFreshUrls(
        (previous as AlbumPhoto[] | undefined)?.filter((p) => !failed.current.has(p.id)),
        next as AlbumPhoto[],
        Date.now(),
      ),
  });
}

type Action =
  | { type: "sync"; photos: AlbumPhoto[] }
  | { type: "tick" | "next" | "prev" | "pause" }
  | { type: "fail"; id: string };

/** The schedule plus the clock it was last advanced at, so rendering never reads the time. */
type Clocked = { slides: SlideshowState; now: number };

function reducer({ slides }: Clocked, action: Action & { now: number }): Clocked {
  const { now } = action;
  switch (action.type) {
    case "sync":
      return { slides: sync(slides, action.photos, now), now };
    case "tick":
      return { slides: tick(slides, now), now };
    case "next":
      return { slides: advance(slides, now), now };
    case "prev":
      return { slides: back(slides, now), now };
    case "pause":
      return { slides: togglePause(slides, now), now };
    case "fail":
      return { slides: fail(slides, action.id, now), now };
  }
}

const TICK_MS = 1_000;
/** Read only in effects and event handlers, never while rendering. */
const wallClock = () => Date.now();

/**
 * /tv/[session] once the night is `tonight` or `closed` (04-frontend.md "TV"): a full-screen
 * slideshow of the album, or, until a photo can be shown, a prompt to drop photos.
 * Remote/keyboard: ← → step, space (or OK / play-pause) pauses and resumes.
 */
export function TvSlideshow({ night, live }: { night: Night; live: LiveState }) {
  const failed = useRef<Set<string>>(new Set());
  const album = useSlideshowAlbum(night.id, live, failed);
  const [{ slides: state, now }, dispatch] = useReducer(reducer, {
    slides: initialSlideshow,
    now: 0,
  });
  const { data, refetch, isFetching } = album;

  useEffect(() => {
    failed.current = failedIds(state);
  }, [state]);

  useEffect(() => {
    if (data) dispatch({ type: "sync", photos: data, now: Date.now() });
  }, [data]);

  // The slide clock.
  useEffect(() => {
    const id = setInterval(() => dispatch({ type: "tick", now: Date.now() }), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Fresh URLs before the old ones run out (ADR-0005).
  useEffect(() => {
    if (!isFetching && refreshDue(state, now)) void refetch();
  }, [state, now, isFetching, refetch]);

  const showing = state.current !== null;
  useEffect(() => {
    if (!showing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a")) return;
      const now = Date.now();
      if (event.key === "ArrowRight") dispatch({ type: "next", now });
      else if (event.key === "ArrowLeft") dispatch({ type: "prev", now });
      else if ([" ", "Enter", "MediaPlayPause"].includes(event.key))
        dispatch({ type: "pause", now });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showing]);

  const photos = new Map((data ?? []).map((p) => [p.id, p]));
  const count = playable(data ?? []).length;

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

  const onFail = (id: string) => {
    dispatch({ type: "fail", id, now: wallClock() });
    failed.current.add(id);
    void refetch();
  };

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
          className="tv-body absolute top-[1.2em] right-[1.2em] z-[3] flex items-center gap-[0.4em] rounded-full bg-black/70 px-[0.9em] py-[0.35em] text-white"
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

/** Alt text from who added it and when, never the filename (there isn't one, by design). */
export function photoAlt(photo: Pick<AlbumPhoto, "person_name" | "taken_on" | "created_at">) {
  return `Photo from ${photo.person_name}, ${photoDate(photo)}`;
}

function photoDate(photo: Pick<AlbumPhoto, "taken_on" | "created_at">): string {
  const format = (date: Date, timeZone?: string) =>
    date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone });
  // taken_on is a calendar date: format it as one, not as midnight UTC shifted into local time.
  return photo.taken_on
    ? format(new Date(`${photo.taken_on}T00:00:00Z`), "UTC")
    : format(new Date(photo.created_at));
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

/** Nothing to show yet: point everyone at their phones, with the code if this TV knows it. */
function DropPrompt({ night, count }: { night: Night; count: number }) {
  const [code] = useState(() => (nightCodeIsLive(night.status) ? recallNightCode(night.id) : null));
  return (
    <section
      aria-labelledby="tv-drop"
      data-testid="tv-photo-idle"
      className="flex flex-1 flex-col items-center justify-center gap-[1.2em] text-center"
    >
      <h2 id="tv-drop" className="tv-display">
        Drop your photos from your phone
      </h2>
      <p className="tv-body text-muted-foreground">
        Open tonight on your phone and add them to the album. They&apos;ll play here.
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
