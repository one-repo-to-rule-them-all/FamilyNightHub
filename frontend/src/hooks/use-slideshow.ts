"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError } from "@/lib/api";
import { type LiveState, pollWhileDown } from "@/lib/live";
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
} from "@/lib/slideshow";

/**
 * The night's album for a slideshow. Keyed under ["night", id] so every live hint (photo_added,
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

/**
 * The slideshow's React glue, shared by the TV (/tv/[session]) and the phone's "Play slideshow"
 * (04-frontend.md "TV slideshow"): the album query, the slideshow.ts schedule, the slide clock,
 * and fresh presigned URLs before the old ones run out (ADR-0005). `live` comes from the
 * screen's own useLiveSession, so there is one stream per screen.
 */
export function useSlideshow(sessionId: string, live: LiveState) {
  const failed = useRef<Set<string>>(new Set());
  const album = useSlideshowAlbum(sessionId, live, failed);
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

  const next = useCallback(() => dispatch({ type: "next", now: Date.now() }), []);
  const prev = useCallback(() => dispatch({ type: "prev", now: Date.now() }), []);
  const pause = useCallback(() => dispatch({ type: "pause", now: Date.now() }), []);
  /** An image failed: skip it, never reuse its URL, and fetch fresh ones. */
  const onFail = useCallback(
    (id: string) => {
      dispatch({ type: "fail", id, now: Date.now() });
      failed.current.add(id);
      void refetch();
    },
    [refetch],
  );

  const photos = new Map((data ?? []).map((p) => [p.id, p]));
  const count = playable(data ?? []).length;
  return { album, state, now, photos, count, next, prev, pause, onFail };
}
