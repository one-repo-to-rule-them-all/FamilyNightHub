/**
 * Album URL bookkeeping (ADR-0005: presigned GETs live 10 minutes and are never cached past that).
 */
import { type Photo } from "@/lib/api";

/** The album is refetched this often while the tab is visible, so other phones' photos appear. */
export const ALBUM_REFRESH_MS = 10_000;
/** Presigned GETs live 10 minutes (ADR-0005). A URL is reused for at most 8, then replaced. */
export const URL_TTL_MS = 10 * 60_000;
export const URL_REUSE_MS = 8 * 60_000;

export type AlbumPhoto = Photo & { urlsMintedAt: number };

/**
 * Every album fetch mints new presigned URLs, and a new `src` means the browser downloads the
 * image again. So a photo keeps the URLs it already has while they are younger than
 * URL_REUSE_MS; reactions and everything else come from the new response. URLs are never kept
 * past that, and the cache entry itself is dropped URL_REUSE_MS after the album is left.
 */
export function keepFreshUrls(
  previous: AlbumPhoto[] | undefined,
  next: AlbumPhoto[],
  now: number,
): AlbumPhoto[] {
  if (!previous) return next;
  const old = new Map(previous.map((p) => [p.id, p]));
  return next.map((photo) => {
    const before = old.get(photo.id);
    if (!before || now - before.urlsMintedAt >= URL_REUSE_MS) return photo;
    return {
      ...photo,
      url: before.url,
      thumb_url: before.thumb_url,
      urlsMintedAt: before.urlsMintedAt,
    };
  });
}
