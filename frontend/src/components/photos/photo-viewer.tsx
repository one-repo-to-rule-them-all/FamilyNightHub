"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PersonAvatar } from "@/components/photos/person-avatar";
import { Button } from "@/components/ui/button";
import { type ApiError, type ReactionEmoji } from "@/lib/api";
import { type AlbumPhoto } from "@/lib/photos/album";
import { cn } from "@/lib/utils";

export const REACTIONS: readonly ReactionEmoji[] = ["❤️", "😂", "😮", "👍", "🎉", "🍿"];

/**
 * Full-screen viewer: the photo, who shared it, and the album's reactions. A native modal
 * <dialog> (focus stays inside, Escape closes). `reactingAs` is null when this phone holds nobody,
 * in which case reactions are shown but can't be tapped.
 */
export function PhotoViewer({
  photo,
  index,
  total,
  reactingAs,
  reactionError,
  onReact,
  onPrevious,
  onNext,
  onClose,
  onImageError,
}: {
  photo: AlbumPhoto;
  index: number;
  total: number;
  reactingAs: string | null;
  reactionError: ApiError | null;
  onReact: (emoji: ReactionEmoji, mine: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onImageError: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const counts = new Map(photo.reactions.map((r) => [r.emoji, r.count]));
  const mine = new Set(
    photo.my_reactions.filter((r) => r.person_id === reactingAs).map((r) => r.emoji),
  );
  const titleId = `viewer-title-${photo.id}`;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-background p-0 text-foreground backdrop:bg-black/80"
      data-testid="photo-viewer"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 px-4 py-3">
          <PersonAvatar emoji={photo.person_avatar_emoji} color={photo.person_color} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-lg font-medium" data-testid="viewer-by">
              {photo.person_name}
            </h2>
            <p className="text-sm text-muted-foreground">
              Photo {index + 1} of {total}
            </p>
          </div>
          <Button variant="ghost" size="tap" className="px-0" onClick={onClose} aria-label="Close">
            <X aria-hidden />
          </Button>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
          {/* A presigned GET straight from the private bucket; Next's optimizer would proxy the
              bytes through the server, which ADR-0005 rules out. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={photo.url}
            src={photo.url}
            alt={`Photo by ${photo.person_name}`}
            referrerPolicy="no-referrer"
            onError={onImageError}
            className="max-h-full max-w-full object-contain"
          />
          {total > 1 ? (
            <>
              <Button
                variant="secondary"
                size="tap"
                className="absolute top-1/2 left-2 -translate-y-1/2 px-0 opacity-80"
                onClick={onPrevious}
                aria-label="Previous photo"
              >
                <ChevronLeft aria-hidden />
              </Button>
              <Button
                variant="secondary"
                size="tap"
                className="absolute top-1/2 right-2 -translate-y-1/2 px-0 opacity-80"
                onClick={onNext}
                aria-label="Next photo"
              >
                <ChevronRight aria-hidden />
              </Button>
            </>
          ) : null}
        </div>

        <footer className="flex flex-col gap-3 px-4 py-4">
          <ApiErrorNotice error={reactionError} />
          <ul className="grid grid-cols-6 gap-2" aria-label="Reactions">
            {REACTIONS.map((emoji) => {
              const count = counts.get(emoji) ?? 0;
              const pressed = mine.has(emoji);
              return (
                <li key={emoji}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    disabled={!reactingAs}
                    onClick={() => onReact(emoji, pressed)}
                    aria-label={`React ${emoji}, ${count}`}
                    data-testid={`react-${emoji}`}
                    className={cn(
                      "flex h-14 w-full flex-col items-center justify-center rounded-xl bg-card text-xl ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-60",
                      pressed && "bg-secondary ring-2 ring-foreground/60",
                    )}
                  >
                    <span aria-hidden>{emoji}</span>
                    <span aria-hidden className="text-xs text-muted-foreground" data-testid="count">
                      {count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </footer>
      </div>
    </dialog>
  );
}
