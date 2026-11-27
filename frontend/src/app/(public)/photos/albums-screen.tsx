"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Images } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { TonightAlbumCard } from "@/components/photos/tonight-album-card";
import { api, type ApiError, type NightAlbum } from "@/lib/api";
import { albumHref, NIGHT_ALBUMS } from "@/lib/photos/target";

/** /photos: tonight's album, then every past night that has photos (ADR-0019). */
export function AlbumsScreen() {
  const albums = useQuery<NightAlbum[], ApiError>({
    queryKey: [...NIGHT_ALBUMS, "list"],
    queryFn: () => api.albums(30),
  });
  const past = (albums.data ?? []).filter((a) => !a.is_tonight);

  return (
    <GuestShell screen="albums" back={{ href: "/", label: "Home" }}>
      <div className="flex flex-col gap-4" data-testid="albums">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Photos</h1>
        <TonightAlbumCard />
        {albums.isError ? <ApiErrorNotice error={albums.error} /> : null}
        {albums.isSuccess && past.length === 0 ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Images aria-hidden className="size-5" />
            Past nights with photos show up here.
          </p>
        ) : null}
        {past.length > 0 ? (
          <ul className="flex flex-col gap-3" aria-label="Past nights">
            {past.map((album) => (
              <li key={album.id ?? album.night_date}>
                <Link
                  href={albumHref(album.id)}
                  data-testid="album-card"
                  className="flex min-h-20 items-center gap-4 rounded-2xl border border-foreground/10 bg-card p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {album.cover_thumb_url ? (
                    // Presigned GET from the private bucket (ADR-0005), never via Next's optimizer.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={album.cover_thumb_url}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={() => void albums.refetch()}
                      className="size-16 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="size-16 shrink-0 rounded-lg bg-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-medium">
                      {album.display_title}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {album.photo_count} photo{album.photo_count === 1 ? "" : "s"}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </GuestShell>
  );
}
