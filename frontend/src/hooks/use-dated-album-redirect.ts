"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { api, type ApiError, type NightAlbum } from "@/lib/api";
import { albumHref, NIGHT_ALBUMS } from "@/lib/photos/target";

/**
 * ADR-0019: a movie night's photos live in the album of its date. Once that album exists,
 * `/albums/[session]` replaces itself with `/photos/[album]`; before it (no photo yet) the
 * night's own album page stays. A 404 is the "not yet" answer, so no retry.
 */
export function useDatedAlbumRedirect(sessionId: string): void {
  const router = useRouter();
  const dated = useQuery<NightAlbum, ApiError>({
    queryKey: [...NIGHT_ALBUMS, "by-session", sessionId],
    queryFn: () => api.albumForSession(sessionId),
    retry: false,
  });
  const albumId = dated.data?.id ?? null;
  useEffect(() => {
    if (albumId) router.replace(albumHref(albumId));
  }, [albumId, router]);
}
