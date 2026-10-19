"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { latestWatchedNightQuery } from "@/components/night/rate-prompt-card";
import { useAlbum } from "@/hooks/use-album";
import type { ApiError, NightSummary, Photo } from "@/lib/api";

/** The strip is a 4-up row (§5 H1 item 5). */
export const STRIP_PHOTOS = 4;

/** Family photos from **{movie}**: up to four ready photos, the whole strip opening the album. */
export function PhotoStripView({
  night,
  photos,
  onBroken,
}: {
  night: Pick<NightSummary, "id" | "title" | "winner">;
  photos: readonly Pick<Photo, "id" | "thumb_url" | "status">[];
  onBroken?: () => void;
}) {
  const shown = photos.filter((p) => p.status === "ready").slice(0, STRIP_PHOTOS);
  if (shown.length === 0) return null;
  const movie = night.winner?.title ?? night.title ?? "movie night";
  return (
    <section
      aria-labelledby="photos-heading"
      className="flex flex-col gap-3"
      data-testid="photo-strip"
    >
      <h2 id="photos-heading" className="font-heading text-lg font-semibold">
        Family photos from <strong>{movie}</strong>
      </h2>
      <Link
        href={`/albums/${encodeURIComponent(night.id)}`}
        aria-label={`See the photos from ${movie}`}
        className="grid grid-cols-4 gap-2 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        {shown.map((photo) => (
          <span key={photo.id} className="block aspect-square overflow-hidden rounded-lg bg-muted">
            {/* Presigned GET from the private bucket (ADR-0005), never via Next's optimizer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.thumb_url}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={onBroken}
              className="size-full object-cover"
            />
          </span>
        ))}
      </Link>
    </section>
  );
}

/**
 * The family photo strip on Home: photos from the household's newest `tonight`/`closed` night
 * (`GET /sessions/{id}/photos`). Hidden while loading, on an error, and when there are none.
 */
export function PhotoStrip() {
  const latest = useQuery<NightSummary[], ApiError>({ ...latestWatchedNightQuery, retry: false });
  const night = latest.data?.[0];
  return night ? <NightStrip night={night} /> : null;
}

function NightStrip({ night }: { night: NightSummary }) {
  const album = useAlbum(night.id);
  if (!album.data) return null;
  // An expired URL (a phone asleep past the TTL): fetch fresh ones.
  return <PhotoStripView night={night} photos={album.data} onBroken={() => void album.refetch()} />;
}
