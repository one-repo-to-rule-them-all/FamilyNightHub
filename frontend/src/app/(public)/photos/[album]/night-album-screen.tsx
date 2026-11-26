"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { PhotoAlbum } from "@/components/photos/photo-album";
import { Button, buttonVariants } from "@/components/ui/button";
import { type Account, api, type ApiError, type NightAlbum } from "@/lib/api";
import { albumTarget, NIGHT_ALBUMS, TONIGHT_ALBUM } from "@/lib/photos/target";
import { cn } from "@/lib/utils";

/**
 * /photos/tonight and /photos/[album] (ADR-0019): a night's photos, with or without a movie
 * night. Tonight's album is open all evening (it is created by the first upload); a past one
 * takes photos for three days after its night, then it is read-only. Signed-in hosts can name
 * the night ("Thanksgiving 2026").
 */
export function NightAlbumScreen({ albumId }: { albumId: string | null }) {
  const meta = useQuery<NightAlbum, ApiError>({
    queryKey: [...NIGHT_ALBUMS, albumId ?? "tonight"],
    queryFn: () => (albumId === null ? api.tonightAlbum() : api.album(albumId)),
  });
  const back = { href: "/photos", label: "Photos" };

  if (meta.isPending || meta.isError) {
    return (
      <GuestShell screen="album" back={back}>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Photos</h1>
        {meta.isError ? (
          <ApiErrorNotice error={meta.error} />
        ) : (
          <div role="status" aria-busy="true" aria-label="Loading the album" className="h-40" />
        )}
      </GuestShell>
    );
  }

  const album = meta.data;
  // Read and react in the concrete album once it exists; until then tonight's (empty) one.
  const readTarget = album.id ? albumTarget(album.id) : TONIGHT_ALBUM;
  const uploadTarget = albumId === null ? TONIGHT_ALBUM : readTarget;

  return (
    <div
      data-testid="night-album-screen"
      data-album-id={album.id ?? ""}
      data-tonight={album.is_tonight}
      className="flex flex-1 flex-col"
    >
      <GuestShell screen="album" back={back}>
        <div className="flex flex-col gap-1">
          <h1
            className="font-heading text-3xl font-semibold tracking-tight"
            data-testid="album-title"
          >
            {album.is_tonight ? "Tonight's album" : album.display_title}
          </h1>
          {album.is_tonight ? (
            <p className="text-lg text-muted-foreground">{album.display_title}</p>
          ) : null}
        </div>
        {album.id ? <RenameAlbum album={album} /> : null}
        <PhotoAlbum
          sessionId={readTarget}
          uploadTarget={uploadTarget}
          heading={album.is_tonight ? "Photos from tonight" : "Photos"}
          live="ready"
          canAdd={album.uploads_open}
        />
        {album.uploads_open ? null : (
          <p className="text-muted-foreground" data-testid="album-closed">
            This album is closed to new photos.
          </p>
        )}
        <Link
          href="/photos"
          className={cn(buttonVariants({ variant: "outline", size: "tap" }), "w-full")}
        >
          All albums
        </Link>
      </GuestShell>
    </div>
  );
}

/** Only signed-in accounts (hosts and admins, `sessions:run`) see this; phones get a 401. */
function RenameAlbum({ album }: { album: NightAlbum }) {
  const queryClient = useQueryClient();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me, retry: false });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(album.title ?? "");
  const rename = useMutation<NightAlbum, ApiError, string>({
    mutationFn: (next) => api.renameAlbum(album.id ?? "", next.trim() === "" ? null : next),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: NIGHT_ALBUMS });
    },
  });

  if (!me.isSuccess) return null;
  if (!editing) {
    return (
      <Button
        variant="ghost"
        className="self-start"
        onClick={() => setEditing(true)}
        data-testid="rename-album"
      >
        Name this night
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate(title);
      }}
    >
      <label htmlFor="album-title" className="text-sm font-medium">
        Album name
      </label>
      <input
        id="album-title"
        value={title}
        maxLength={80}
        placeholder={album.display_title}
        onChange={(event) => setTitle(event.target.value)}
        className="h-12 rounded-xl border border-input bg-background px-3 text-lg"
      />
      {rename.isError ? <ApiErrorNotice error={rename.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={rename.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
