"use client";

import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { PhoneScreen } from "@/components/phone-screen";
import { PhotoAlbum } from "@/components/photos/photo-album";
import { buttonVariants } from "@/components/ui/button";
import { useHouseholdNight } from "@/hooks/use-household-night";
import { useLiveSession } from "@/hooks/use-live-session";
import { type Night } from "@/lib/api";
import { cn } from "@/lib/utils";

import { ScreenTitle } from "../../s/[session]/screen-title";

/** The album opens once the movie is picked and stays open after the night closes (ADR-0005). */
const ALBUM_OPEN: ReadonlySet<Night["status"]> = new Set(["tonight", "closed"]);

/**
 * /albums/[session]: one night's photos on their own, e.g. from history days later. Inside the
 * guest shell with **‹** back to the night (guest-home §5 H6); a live night shows the plain
 * hand-off (no countdown here, AC-H3.11). While a night is live the hand-off's Go is the one
 * primary, so **Add photos** turns `secondary` (guest-home §4 rule 1).
 */
export function AlbumScreen({ sessionId }: { sessionId: string }) {
  const night = useLiveSession(sessionId);
  const { night: liveNight } = useHouseholdNight(night.isSuccess);
  const back = { href: `/s/${sessionId}`, label: "Movie night" };

  // No device on this browser: the shell's person and nav mean nothing yet, so no shell.
  if (night.isError && night.error.status === 401) {
    return (
      <PhoneScreen title="Photos" screen="album">
        <p role="alert" className="rounded-xl bg-card p-5 text-lg">
          Join a movie night on this phone to see your family&apos;s photos.
        </p>
      </PhoneScreen>
    );
  }

  if (night.isPending || night.isError) {
    return (
      <GuestShell screen="album" back={back}>
        <ScreenTitle title="Photos" />
        {night.isError ? (
          <ApiErrorNotice error={night.error} />
        ) : (
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
        )}
      </GuestShell>
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
      <GuestShell screen="album" back={back}>
        <ScreenTitle title="Photos" lede={winner ? winner.title : night.data.title} />
        {ALBUM_OPEN.has(night.data.status) ? (
          <PhotoAlbum sessionId={sessionId} live={night.live} primary={liveNight === undefined} />
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
      </GuestShell>
    </div>
  );
}
