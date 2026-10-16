import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AlbumPhoto, URL_REUSE_MS, URL_TTL_MS } from "@/lib/photos/album";

import {
  advance,
  back,
  canLoad,
  fail,
  failedIds,
  initialSlideshow,
  LOAD_MARGIN_MS,
  MAX_CONCURRENT_LOADS,
  playable,
  refreshDue,
  SLIDE_MS,
  type SlideshowState,
  sync,
  tick,
  togglePause,
  upcoming,
} from "./slideshow";

const T0 = Date.UTC(2026, 9, 15, 20, 0, 0);

/** A ready photo uploaded `minute` minutes after T0, URLs minted at `mintedAt`. */
function photo(id: string, minute: number, mintedAt = Date.now()): AlbumPhoto {
  return {
    id,
    person_id: "p",
    person_name: "Ava",
    person_avatar_emoji: "🦊",
    person_color: "#f80",
    status: "ready",
    taken_on: null,
    created_at: new Date(T0 + minute * 60_000).toISOString(),
    url: `https://bucket/${id}?X-Amz-Signature=x`,
    thumb_url: `https://bucket/${id}-t?X-Amz-Signature=x`,
    reactions: [],
    my_reactions: [],
    urlsMintedAt: mintedAt,
  };
}

/** Newest first, as the API lists them. */
const album = (...photos: AlbumPhoto[]) =>
  [...photos].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

const now = () => Date.now();

/** Advances the clock and runs one scheduler tick. */
function after(state: SlideshowState, ms: number): SlideshowState {
  vi.advanceTimersByTime(ms);
  return tick(state, now());
}

/** The ids shown over `slides` slide periods, starting with what's on screen. */
function play(state: SlideshowState, slides: number): (string | null)[] {
  const shown = [state.current];
  let s = state;
  for (let i = 0; i < slides; i++) {
    s = after(s, SLIDE_MS);
    shown.push(s.current);
  }
  return shown;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 60 * 60_000);
});
afterEach(() => vi.useRealTimers());

describe("playable", () => {
  it("keeps ready photos only, oldest first, ties broken by id", () => {
    const hidden = { ...photo("h", 0), status: "hidden" as const };
    const list = playable([photo("c", 2), photo("b", 1), hidden, photo("a", 1)]);
    expect(list.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sync", () => {
  it("starts on the newest photo, then loops chronologically", () => {
    const s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());
    expect(s.current).toBe("c");
    expect(play(s, 4)).toEqual(["c", "a", "b", "c", "a"]);
  });

  it("an empty first album leaves nothing on screen, and the first upload jumps in", () => {
    let s = sync(initialSlideshow, [], now());
    expect(s).toMatchObject({ synced: true, current: null });
    expect(tick(s, now())).toBe(s);
    s = sync(s, album(photo("a", 1)), now());
    expect(s.current).toBe("a");
  });

  it("a just-uploaded photo jumps the queue once, then the loop resumes where it was", () => {
    let s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());
    s = after(s, SLIDE_MS); // a
    s = sync(s, album(photo("a", 1), photo("b", 2), photo("c", 3), photo("d", 4)), now());
    expect(s.current).toBe("a"); // the slide on screen keeps its time
    expect(s.jumps).toEqual(["d"]);
    expect(play(s, 5)).toEqual(["a", "d", "b", "c", "d", "a"]);
  });

  it("several new photos jump in newest first", () => {
    let s = sync(initialSlideshow, album(photo("a", 1)), now());
    s = sync(s, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());
    expect(s.jumps).toEqual(["c", "b"]);
    // The loop resumes after a; b just played, so it moves on to c.
    expect(play(s, 3)).toEqual(["a", "c", "b", "c"]);
  });

  it("drops a photo the API no longer lists, at once, even mid-slide", () => {
    let s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());
    s = after(s, SLIDE_MS); // a
    s = after(s, SLIDE_MS); // b
    vi.advanceTimersByTime(1_000);
    s = sync(s, album(photo("a", 1), photo("c", 3)), now());
    expect(s.current).toBe("c");
    expect(s.shownAt).toBe(now());
    expect(s.order).toEqual(["a", "c"]);
  });

  it("a hidden queue-jumper never plays", () => {
    let s = sync(initialSlideshow, album(photo("a", 1)), now());
    s = sync(s, album(photo("a", 1), photo("b", 2)), now());
    s = sync(s, album(photo("a", 1), { ...photo("b", 2), status: "hidden" }), now());
    expect(s.jumps).toEqual([]);
    expect(play(s, 2)).toEqual(["a", "a", "a"]);
  });

  it("keeps the loop's place when its anchor is removed", () => {
    let s = sync(
      initialSlideshow,
      album(photo("a", 1), photo("b", 2), photo("c", 3), photo("d", 4)),
      now(),
    );
    s = after(s, SLIDE_MS); // a
    s = after(s, SLIDE_MS); // b (anchor)
    s = sync(
      s,
      album(photo("a", 1), photo("b", 2), photo("c", 3), photo("d", 4), photo("e", 5)),
      now(),
    );
    s = after(s, SLIDE_MS); // e jumps; anchor stays b
    expect(s.current).toBe("e");
    s = sync(s, album(photo("a", 1), photo("c", 3), photo("d", 4), photo("e", 5)), now());
    expect(s.anchor).toBe("a");
    expect(play(s, 2)).toEqual(["e", "c", "d"]);
  });

  it("loses the anchor entirely when nothing before it survives", () => {
    let s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2)), now());
    s = after(s, SLIDE_MS); // a (anchor)
    s = sync(s, album(photo("b", 2), photo("c", 3)), now());
    // a vanished with nothing before it; c is new and jumps in.
    expect(s.current).toBe("c");
    expect(s.anchor).toBeNull();
    expect(play(s, 2)).toEqual(["c", "b", "c"]);
  });

  it("emptying the album clears the screen", () => {
    let s = sync(initialSlideshow, album(photo("a", 1)), now());
    s = sync(s, [], now());
    expect(s.current).toBeNull();
  });
});

describe("controls", () => {
  const three = () =>
    sync(initialSlideshow, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());

  it("right steps forward and restarts the slide's time; left steps back, wrapping", () => {
    let s = three(); // c
    vi.advanceTimersByTime(5_000);
    s = advance(s, now());
    expect(s).toMatchObject({ current: "a", anchor: "a", shownAt: now() });
    s = back(s, now());
    expect(s.current).toBe("c");
    s = back(s, now());
    expect(s.current).toBe("b");
  });

  it("right plays a queue-jumper before the loop", () => {
    let s = three();
    s = sync(s, album(photo("a", 1), photo("b", 2), photo("c", 3), photo("d", 4)), now());
    s = advance(s, now());
    expect(s.current).toBe("d");
  });

  it("left with nothing else to show stays put", () => {
    const s = sync(initialSlideshow, album(photo("a", 1)), now());
    expect(back(s, now())).toBe(s);
    expect(back(sync(initialSlideshow, [], now()), now()).current).toBeNull();
  });

  it("pause holds the slide; resume gives it a full slide again", () => {
    let s = togglePause(three(), now());
    expect(s.paused).toBe(true);
    expect(after(s, SLIDE_MS * 5)).toBe(s);
    s = togglePause(s, now());
    expect(s).toMatchObject({ paused: false, shownAt: now(), current: "c" });
    s = after(s, SLIDE_MS - 1);
    expect(s.current).toBe("c");
    s = after(s, 1);
    expect(s.current).toBe("a");
  });

  it("stepping while paused still works and stays paused", () => {
    let s = togglePause(three(), now());
    s = advance(s, now());
    expect(s).toMatchObject({ current: "a", paused: true });
  });

  it("upcoming is what the next step would show, for preloading", () => {
    const s = three();
    expect(upcoming(s, now())).toBe("a");
    expect(upcoming(sync(initialSlideshow, album(photo("a", 1)), now()), now())).toBeNull();
    expect(MAX_CONCURRENT_LOADS).toBe(2);
  });
});

describe("presigned URLs (ADR-0005)", () => {
  it("never starts a load within the margin of a URL's expiry", () => {
    const minted = now();
    const s = sync(initialSlideshow, album(photo("a", 1, minted)), now());
    expect(canLoad(s, "a", minted + URL_TTL_MS - LOAD_MARGIN_MS - 1)).toBe(true);
    expect(canLoad(s, "a", minted + URL_TTL_MS - LOAD_MARGIN_MS)).toBe(false);
    expect(canLoad(s, "nope", minted)).toBe(false);
  });

  it("asks for a refetch once a URL is past album.ts's reuse window", () => {
    const s = sync(initialSlideshow, album(photo("a", 1)), now());
    expect(refreshDue(s, now())).toBe(false);
    vi.advanceTimersByTime(URL_REUSE_MS - 1);
    expect(refreshDue(s, now())).toBe(false);
    vi.advanceTimersByTime(1);
    expect(refreshDue(s, now())).toBe(true);
  });

  it("skips photos whose URLs are too old to load, and shows nothing if none are left", () => {
    const old = now() - (URL_TTL_MS - LOAD_MARGIN_MS);
    let s = sync(initialSlideshow, album(photo("a", 1, old), photo("b", 2)), now());
    expect(s.current).toBe("b");
    expect(play(s, 2)).toEqual(["b", "b", "b"]);
    s = sync(initialSlideshow, album(photo("a", 1, old)), now());
    expect(s.current).toBeNull();
    expect(tick(s, now())).toBe(s);
    // Fresh URLs arrive: the slideshow picks the photo up on the next tick.
    s = sync(s, album(photo("a", 1)), now());
    expect(s.current).toBe("a");
  });

  it("drops a queue-jumper whose URL went stale before its turn", () => {
    let s = sync(initialSlideshow, album(photo("a", 1)), now());
    s = sync(s, album(photo("a", 1), photo("b", 2, now() - URL_TTL_MS)), now());
    expect(s.jumps).toEqual(["b"]);
    s = advance(s, now());
    expect(s).toMatchObject({ current: "a", jumps: [] });
  });
});

describe("broken images", () => {
  it("skips a failed photo until it gets a new URL, and lists it so the refetch replaces it", () => {
    let s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());
    s = fail(s, "c", now()); // on screen: skip at once
    expect(s.current).toBe("a");
    expect(failedIds(s)).toEqual(new Set(["c"]));
    expect(play(s, 2)).toEqual(["a", "b", "a"]);
    // Same URL back from the refetch: still skipped.
    s = sync(
      s,
      album(photo("a", 1), photo("b", 2), { ...photo("c", 3), urlsMintedAt: s.minted.c }),
      now(),
    );
    expect(failedIds(s).has("c")).toBe(true);
    vi.advanceTimersByTime(1_000);
    s = sync(s, album(photo("a", 1), photo("b", 2), photo("c", 3)), now());
    expect(failedIds(s).size).toBe(0);
    expect(canLoad(s, "c", now())).toBe(true);
  });

  it("a failure off screen doesn't move the slideshow; an unknown id is ignored", () => {
    const s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2)), now());
    const failed = fail(s, "a", now());
    expect(failed.current).toBe("b");
    expect(upcoming(failed, now())).toBeNull();
    expect(fail(s, "zzz", now())).toBe(s);
  });

  it("a removed photo's failure is forgotten", () => {
    let s = sync(initialSlideshow, album(photo("a", 1), photo("b", 2)), now());
    s = fail(s, "a", now());
    s = sync(s, album(photo("b", 2)), now());
    expect(s.failed).toEqual({});
  });
});
