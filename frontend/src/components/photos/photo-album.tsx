"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PersonAvatar } from "@/components/photos/person-avatar";
import { PhoneSlideshow } from "@/components/photos/phone-slideshow";
import { PhotoDrop } from "@/components/photos/photo-drop";
import { PhotoViewer } from "@/components/photos/photo-viewer";
import { Button, buttonVariants } from "@/components/ui/button";
import { albumKey, useAlbum } from "@/hooks/use-album";
import { api, type ApiError, type Person, type ReactionEmoji } from "@/lib/api";
import { type LiveState } from "@/lib/live";
import { cn } from "@/lib/utils";

const PEOPLE = ["people"] as const;

type ReactionChange = { photoId: string; emoji: ReactionEmoji; mine: boolean; personId: string };

/**
 * The night's photos on a phone (04-frontend.md "Photo drop"): "Add photos" for the people this
 * phone holds, then the album as a thumbnail grid that opens a full-screen viewer with reactions.
 * Used on /s/[session] (tonight, closed) and /albums/[session]. "Play slideshow" opens the TV's
 * slideshow full screen on this phone; `live` is the screen's own useLiveSession state.
 */
export function PhotoAlbum({
  sessionId,
  live,
  canAdd = true,
}: {
  sessionId: string;
  live: LiveState;
  canAdd?: boolean;
}) {
  const queryClient = useQueryClient();
  const album = useAlbum(sessionId);
  const people = useQuery<Person[], ApiError>({ queryKey: PEOPLE, queryFn: api.people });
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const react = useMutation<void, ApiError, ReactionChange>({
    mutationFn: ({ photoId, emoji, mine, personId }) =>
      mine
        ? api.unreact(sessionId, photoId, emoji, personId)
        : api.react(sessionId, photoId, emoji, personId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: albumKey(sessionId) }),
  });

  const mine = (people.data ?? []).filter((p) => p.binding === "mine");
  const actor = mine.find((p) => p.id === chosen) ?? mine[0] ?? null;
  const photos = album.data ?? [];
  const index = photos.findIndex((p) => p.id === open);
  const current = index >= 0 ? photos[index] : null;

  return (
    <section aria-labelledby="photos-heading" className="flex flex-col gap-4" data-testid="photos">
      <h2 id="photos-heading" className="text-xl font-medium">
        Photos from tonight
      </h2>

      {canAdd ? (
        people.isPending ? null : mine.length === 0 ? (
          <Link
            href="/who"
            className={cn(buttonVariants({ variant: "outline", size: "tap" }), "w-full")}
          >
            Pick who you are to add photos
          </Link>
        ) : (
          <>
            {mine.length > 1 ? (
              <div className="flex flex-col gap-2">
                <p className="text-muted-foreground" id="sharing-as">
                  Sharing as
                </p>
                <div role="group" aria-labelledby="sharing-as" className="flex flex-wrap gap-2">
                  {mine.map((person) => (
                    <button
                      key={person.id}
                      type="button"
                      aria-pressed={person.id === actor?.id}
                      onClick={() => setChosen(person.id)}
                      className={cn(
                        "flex h-14 items-center gap-2 rounded-full bg-card pr-4 pl-2 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring",
                        person.id === actor?.id && "ring-2 ring-foreground/60",
                      )}
                    >
                      <PersonAvatar emoji={person.avatar_emoji} color={person.color} />
                      {person.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {actor ? <PhotoDrop sessionId={sessionId} personId={actor.id} /> : null}
          </>
        )
      ) : null}

      {album.isError ? (
        <ApiErrorNotice error={album.error} />
      ) : album.isPending ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading photos"
          className="grid grid-cols-3 gap-2"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : photos.length === 0 ? (
        <p className="flex items-center gap-2 text-muted-foreground" data-testid="album-empty">
          <Camera aria-hidden className="size-5" />
          No photos yet.
        </p>
      ) : (
        <>
          {photos.some((p) => p.status === "ready") ? (
            <Button
              variant="secondary"
              size="tap"
              className="w-full"
              onClick={() => setPlaying(true)}
              data-testid="play-slideshow"
            >
              <Play aria-hidden className="fill-current" />
              Play slideshow
            </Button>
          ) : null}
          <ul className="grid grid-cols-3 gap-2" data-testid="album-grid">
            {photos.map((photo) => (
              <li key={photo.id}>
                <button
                  type="button"
                  onClick={() => {
                    react.reset();
                    setOpen(photo.id);
                  }}
                  aria-label={`Open photo by ${photo.person_name}`}
                  className="block aspect-square w-full overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring"
                >
                  {/* Presigned GET from the private bucket (ADR-0005), never via Next's optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.thumb_url}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    // An expired URL (a phone asleep past the TTL): fetch fresh ones.
                    onError={() => void album.refetch()}
                    className="size-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {playing ? (
        <PhoneSlideshow sessionId={sessionId} live={live} onClose={() => setPlaying(false)} />
      ) : null}

      {current ? (
        <PhotoViewer
          photo={current}
          index={index}
          total={photos.length}
          reactingAs={actor?.id ?? null}
          reactionError={react.error}
          onReact={(emoji, isMine) => {
            if (!actor) return;
            react.mutate({ photoId: current.id, emoji, mine: isMine, personId: actor.id });
          }}
          onPrevious={() => setOpen(photos[(index - 1 + photos.length) % photos.length].id)}
          onNext={() => setOpen(photos[(index + 1) % photos.length].id)}
          onClose={() => setOpen(null)}
          onImageError={() => void album.refetch()}
        />
      ) : null}
    </section>
  );
}
