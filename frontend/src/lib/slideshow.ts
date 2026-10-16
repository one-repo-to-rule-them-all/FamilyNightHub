/**
 * The TV slideshow's scheduling (04-frontend.md "TV"), kept free of React and timers so every
 * decision is unit-tested with fake timers: which photo is on screen, which one is preloaded next,
 * when to advance, and when the album must be refetched for fresh presigned URLs (ADR-0005).
 *
 * Order: the loop walks the album chronologically (oldest first) and starts at the newest photo.
 * A photo that wasn't in the album before (just uploaded) jumps the queue once, newest first; the
 * loop then resumes where it was. A photo the API stops listing (hidden, deleted) leaves at once,
 * even mid-slide. A photo whose image failed is skipped until the album hands it a new URL.
 *
 * The state holds ids and mint times only, never a URL: URLs stay on the album photos, so the
 * only place one reaches the DOM is the <img src> that renders it.
 */
import { type AlbumPhoto, URL_REUSE_MS, URL_TTL_MS } from "@/lib/photos/album";

/** How long each photo stays on screen. */
export const SLIDE_MS = 8_000;
/** A load is never started on a URL this close to its expiry (it may outlive a slow download). */
export const LOAD_MARGIN_MS = 60_000;
/** Image loads in flight at most: the photo on screen and the one preloaded after it. */
export const MAX_CONCURRENT_LOADS = 2;

export type SlideshowState = {
  /** Ready photo ids, oldest first. */
  order: readonly string[];
  /** When each photo's current URLs were minted (album.ts `urlsMintedAt`). */
  minted: Readonly<Record<string, number>>;
  /** Just-uploaded photos waiting to jump the queue, newest first. Each plays once. */
  jumps: readonly string[];
  /** The photo on screen. */
  current: string | null;
  /** The loop's position. A photo shown because it jumped the queue doesn't move it. */
  anchor: string | null;
  paused: boolean;
  /** When `current` went on screen (or the slideshow resumed). */
  shownAt: number;
  /** Photos whose image failed, with the mint time of the URL that failed. */
  failed: Readonly<Record<string, number>>;
  /** False until the first album arrives: photos in it are not "just uploaded". */
  synced: boolean;
};

export const initialSlideshow: SlideshowState = {
  order: [],
  minted: {},
  jumps: [],
  current: null,
  anchor: null,
  paused: false,
  shownAt: 0,
  failed: {},
  synced: false,
};

/** The photos the TV may show: `ready` only (a host-signed-in TV also gets hidden ones), oldest first. */
export function playable<P extends Pick<AlbumPhoto, "id" | "status" | "created_at">>(
  photos: readonly P[],
): P[] {
  return photos
    .filter((photo) => photo.status === "ready")
    .sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
    );
}

/** May an image load start for this photo now? Never on a failed URL or one near its expiry. */
export function canLoad(state: SlideshowState, id: string, now: number): boolean {
  const minted = state.minted[id];
  if (minted === undefined || state.failed[id] !== undefined) return false;
  return now - minted < URL_TTL_MS - LOAD_MARGIN_MS;
}

/**
 * Should the album be refetched now? Once the oldest URL is past album.ts's reuse window, so a
 * refetch mints new ones. The album's own interval normally gets there first; this covers a
 * refetch that failed or a tab that was hidden. (A failed image triggers its own refetch.)
 */
export function refreshDue(state: SlideshowState, now: number): boolean {
  return state.order.some((id) => now - state.minted[id] >= URL_REUSE_MS);
}

/** Ids whose URLs must not be reused by album.ts on the next refetch: they failed to load. */
export function failedIds(state: SlideshowState): Set<string> {
  return new Set(Object.keys(state.failed));
}

/** Folds a fresh album response in. */
export function sync(
  state: SlideshowState,
  photos: readonly AlbumPhoto[],
  now: number,
): SlideshowState {
  const ready = playable(photos);
  const order = ready.map((photo) => photo.id);
  const present = new Set(order);
  const minted: Record<string, number> = {};
  for (const photo of ready) minted[photo.id] = photo.urlsMintedAt;

  const known = new Set(state.order);
  const added = state.synced ? order.filter((id) => !known.has(id)).reverse() : [];
  const jumps = [...added, ...state.jumps.filter((id) => present.has(id))];

  // A failure is forgotten once the photo is gone or has a new URL to try.
  const failed: Record<string, number> = {};
  for (const [id, at] of Object.entries(state.failed)) {
    if (minted[id] === at) failed[id] = at;
  }

  const next: SlideshowState = {
    ...state,
    order,
    minted,
    jumps,
    failed,
    synced: true,
    anchor: survivingAnchor(state, present),
  };

  if (!state.synced) {
    // First album: start on the newest photo, then loop chronologically from there.
    const newest = [...order].reverse().find((id) => canLoad(next, id, now)) ?? null;
    return { ...next, current: newest, anchor: newest, shownAt: now };
  }
  if (next.current !== null && present.has(next.current)) return next;
  // Nothing on screen yet, or what was on screen is gone: replace it now.
  return advance({ ...next, current: null }, now);
}

/** The anchor, or (if it left the album) the nearest earlier photo that's still there. */
function survivingAnchor(state: SlideshowState, present: Set<string>): string | null {
  if (state.anchor === null) return null;
  const at = state.order.indexOf(state.anchor);
  for (let i = at; i >= 0; i--) {
    if (present.has(state.order[i])) return state.order[i];
  }
  return null;
}

/** Steps forward: a queue-jumper first, else the loop's next photo (wrapping). */
export function advance(state: SlideshowState, now: number): SlideshowState {
  const jumps = [...state.jumps];
  while (jumps.length > 0) {
    const id = jumps.shift()!;
    if (canLoad(state, id, now)) return { ...state, jumps, current: id, shownAt: now };
  }
  const id = walk(state, state.anchor, 1, now);
  return { ...state, jumps, current: id, anchor: id ?? state.anchor, shownAt: now };
}

/** Steps back through the loop from the photo on screen. */
export function back(state: SlideshowState, now: number): SlideshowState {
  const id = walk(state, state.current, -1, now);
  if (id === null || id === state.current) return state;
  return { ...state, current: id, anchor: id, shownAt: now };
}

/**
 * The next loadable photo from `from` in direction `step`, wrapping. The photo already on screen
 * is picked only when it's the only one left. `from === null` starts before the oldest.
 */
function walk(
  state: SlideshowState,
  from: string | null,
  step: 1 | -1,
  now: number,
): string | null {
  const n = state.order.length;
  const start = from === null ? (step === 1 ? -1 : 0) : state.order.indexOf(from);
  let fallback: string | null = null;
  for (let k = 1; k <= n; k++) {
    const id = state.order[(((start + step * k) % n) + n) % n];
    if (!canLoad(state, id, now)) continue;
    if (id !== state.current) return id;
    fallback = id;
  }
  return fallback;
}

/** The photo the next step would show: preloaded so the crossfade never waits on the network. */
export function upcoming(state: SlideshowState, now: number): string | null {
  const id = advance(state, now).current;
  return id === state.current ? null : id;
}

/**
 * Called every second or so: advance once the slide has had its time (never while paused).
 * An empty screen waits for `sync`: only a new album can make a photo loadable again.
 */
export function tick(state: SlideshowState, now: number): SlideshowState {
  if (state.paused || state.current === null) return state;
  return now - state.shownAt >= SLIDE_MS ? advance(state, now) : state;
}

export function togglePause(state: SlideshowState, now: number): SlideshowState {
  return state.paused ? { ...state, paused: false, shownAt: now } : { ...state, paused: true };
}

/** An image failed to load (broken, or expired after all): skip it until its URL changes. */
export function fail(state: SlideshowState, id: string, now: number): SlideshowState {
  const minted = state.minted[id];
  if (minted === undefined) return state;
  const next = { ...state, failed: { ...state.failed, [id]: minted } };
  return next.current === id ? advance(next, now) : next;
}
