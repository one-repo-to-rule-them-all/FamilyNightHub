/**
 * Where a photo goes and is read from (ADR-0019). The photo components, the album query and the
 * IndexedDB upload queue all carry one string key:
 *
 * - a movie night's id (the ADR-0005 shape, and what jobs queued before night albums hold):
 *   `/sessions/{id}/photos`;
 * - `album:tonight`: tonight's night album, created on the first upload;
 * - `album:{id}`: one night album.
 *
 * `album:tonight` is only for creating and listing. A created photo is completed in the album
 * the server put it in (`album:{album_id}`), so a 4:00 rollover mid-upload can't misroute it.
 */

export const TONIGHT_ALBUM = "album:tonight";
/** React Query prefix for album metadata (the list, tonight's, one album). */
export const NIGHT_ALBUMS = ["night-albums"] as const;

export type AlbumTarget = { kind: "session"; id: string } | { kind: "album"; id: string };

const PREFIX = "album:";

export function albumTarget(albumId: string): string {
  return `${PREFIX}${albumId}`;
}

export function parseTarget(key: string): AlbumTarget {
  return key.startsWith(PREFIX)
    ? { kind: "album", id: key.slice(PREFIX.length) }
    : { kind: "session", id: key };
}

export function isAlbumTarget(key: string): boolean {
  return parseTarget(key).kind === "album";
}

/** The API path of the target's photo collection (relative to /api/v1). */
export function photosPath(key: string): string {
  const t = parseTarget(key);
  const id = encodeURIComponent(t.id);
  return t.kind === "album" ? `/albums/${id}/photos` : `/sessions/${id}/photos`;
}

/** The phone route of an album: `/photos/tonight`, `/photos/{id}`. */
export function albumHref(albumId: string | null): string {
  return `/photos/${albumId === null ? "tonight" : encodeURIComponent(albumId)}`;
}
