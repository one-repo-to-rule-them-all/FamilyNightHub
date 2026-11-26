"use client";

import { useQuery } from "@tanstack/react-query";
import { Camera, ChevronRight } from "lucide-react";
import Link from "next/link";

import { api, type ApiError, type NightAlbum } from "@/lib/api";
import { albumHref, NIGHT_ALBUMS } from "@/lib/photos/target";

/**
 * "Tonight's album" (ADR-0019): the always-available way to add photos, on Home and in the
 * Games tab, whether or not there is a movie night. A link, never a primary: those screens
 * already have one.
 */
export function TonightAlbumCard() {
  const tonight = useQuery<NightAlbum, ApiError>({
    queryKey: [...NIGHT_ALBUMS, "tonight"],
    queryFn: api.tonightAlbum,
  });
  const count = tonight.data?.photo_count ?? 0;
  return (
    <Link
      href={albumHref(null)}
      data-testid="tonight-album-card"
      className="flex min-h-20 items-center gap-4 rounded-2xl border border-foreground/10 bg-card p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Camera aria-hidden className="size-8 shrink-0 text-cinema" />
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-medium">Tonight&apos;s album</span>
        <span className="block text-sm text-muted-foreground" data-testid="tonight-album-count">
          {count === 0 ? "Add the first photo" : `${count} photo${count === 1 ? "" : "s"}`}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
    </Link>
  );
}
