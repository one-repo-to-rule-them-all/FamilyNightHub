import { describe, expect, it } from "vitest";

import { type AlbumPhoto, keepFreshUrls, URL_REUSE_MS, URL_TTL_MS } from "./album";

const photo = (id: string, mintedAt: number, hearts = 0): AlbumPhoto => ({
  id,
  person_id: "ava",
  person_name: "Ava",
  person_avatar_emoji: "🦄",
  person_color: "#ec4899",
  status: "ready",
  taken_on: null,
  created_at: "2026-10-10T20:00:00Z",
  url: `https://bucket.test/${id}.jpg?t=${mintedAt}`,
  thumb_url: `https://bucket.test/${id}_thumb.jpg?t=${mintedAt}`,
  reactions: hearts ? [{ emoji: "❤️", count: hearts }] : [],
  my_reactions: [],
  urlsMintedAt: mintedAt,
});

describe("keepFreshUrls", () => {
  it("keeps a photo's URLs while they are young, but takes everything else from the new data", () => {
    const now = 100_000;
    const merged = keepFreshUrls([photo("a", now - 60_000)], [photo("a", now, 2)], now);
    expect(merged[0].url).toBe(photo("a", now - 60_000).url);
    expect(merged[0].thumb_url).toBe(photo("a", now - 60_000).thumb_url);
    expect(merged[0].urlsMintedAt).toBe(now - 60_000);
    expect(merged[0].reactions).toEqual([{ emoji: "❤️", count: 2 }]);
  });

  it("replaces URLs before they can expire, and never reuses one past the TTL", () => {
    expect(URL_REUSE_MS).toBeLessThan(URL_TTL_MS);
    const now = 10 * URL_TTL_MS;
    const merged = keepFreshUrls([photo("a", now - URL_REUSE_MS)], [photo("a", now)], now);
    expect(merged[0].url).toBe(photo("a", now).url);
    expect(merged[0].urlsMintedAt).toBe(now);
  });

  it("takes new photos as they come and drops removed ones", () => {
    const now = 50_000;
    const next = [photo("new", now), photo("a", now)];
    const merged = keepFreshUrls([photo("a", now - 1), photo("hidden", now - 1)], next, now);
    expect(merged.map((p) => p.id)).toEqual(["new", "a"]);
    expect(merged[0]).toBe(next[0]);
    expect(keepFreshUrls(undefined, next, now)).toBe(next);
  });
});
