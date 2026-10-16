"use client";

import { useQuery } from "@tanstack/react-query";

import { api, type ApiError } from "@/lib/api";
import { ALBUM_REFRESH_MS, type AlbumPhoto, keepFreshUrls, URL_REUSE_MS } from "@/lib/photos/album";

export const albumKey = (sessionId: string) => ["album", sessionId] as const;

export function useAlbum(sessionId: string) {
  return useQuery<AlbumPhoto[], ApiError>({
    queryKey: albumKey(sessionId),
    queryFn: async () => {
      const photos = await api.photos(sessionId);
      const mintedAt = Date.now();
      return photos.map((p) => ({ ...p, urlsMintedAt: mintedAt }));
    },
    refetchInterval: ALBUM_REFRESH_MS,
    gcTime: URL_REUSE_MS,
    structuralSharing: (previous, next) =>
      keepFreshUrls(previous as AlbumPhoto[] | undefined, next as AlbumPhoto[], Date.now()),
  });
}
