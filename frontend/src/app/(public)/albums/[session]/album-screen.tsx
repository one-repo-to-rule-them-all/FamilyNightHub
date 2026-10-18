"use client";

import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PhoneScreen } from "@/components/phone-screen";
import { PhotoAlbum } from "@/components/photos/photo-album";
import { buttonVariants } from "@/components/ui/button";
import { useLiveSession } from "@/hooks/use-live-session";
import { type Night } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The album opens once the movie is picked and stays open after the night closes (ADR-0005). */
const ALBUM_OPEN: ReadonlySet<Night["status"]> = new Set(["tonight", "closed"]);

/** /albums/[session]: one night's photos on their own, e.g. from history days later. */
export function AlbumScreen({ sessionId }: { sessionId: string }) {
  const night = useLiveSession(sessionId);

  if (night.isPending) {
    return (
      <PhoneScreen title="Photos">
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading the album"
          className="grid grid-cols-3 gap-2"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      </PhoneScreen>
    );
  }
  if (night.isError) {
    return (
      <PhoneScreen title="Photos">
        {night.error.status === 401 ? (
          <p role="alert" className="rounded-xl bg-card p-5 text-lg">
            Join a movie night on this phone to see your family&apos;s photos.
          </p>
        ) : (
          <ApiErrorNotice error={night.error} />
        )}
      </PhoneScreen>
    );
  }

  const winner = night.data.result
    ? night.data.options.find((o) => o.id === night.data.result?.winner_option_id)
    : undefined;

  return (
    <div
      data-testid="album-screen"
      data-status={night.data.status}
      data-live={night.live}
      className="flex flex-1 flex-col"
    >
      <PhoneScreen title="Photos" lede={winner ? winner.title : night.data.title}>
        {ALBUM_OPEN.has(night.data.status) ? (
          <PhotoAlbum sessionId={sessionId} live={night.live} />
        ) : (
          <p className="text-lg text-muted-foreground">
            Photos open once tonight&apos;s movie is picked.
          </p>
        )}
        <Link
          href={`/s/${sessionId}`}
          className={cn(buttonVariants({ variant: "outline", size: "tap" }), "w-full")}
        >
          Back to the night
        </Link>
      </PhoneScreen>
    </div>
  );
}
