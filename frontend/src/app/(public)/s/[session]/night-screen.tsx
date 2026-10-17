"use client";

import { Clock } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PhoneScreen } from "@/components/phone-screen";
import { RatingPanel } from "@/components/night/rating-panel";
import { PhotoAlbum } from "@/components/photos/photo-album";
import { Button, buttonVariants } from "@/components/ui/button";
import { type LiveState, useLiveSession } from "@/hooks/use-live-session";
import type { Night } from "@/lib/api";
import { cn } from "@/lib/utils";

import { VotingFlow } from "./voting-flow";
import { Results, WinnerCard } from "./winner";

/**
 * /s/[session]: the phone's view of one night, driven by the snapshot's `status`
 * (04-frontend.md "Phone state machine"). `data-live` mirrors useLiveSession, so tests and the
 * later SSE hook agree on when the screen is live.
 */
export function NightScreen({ sessionId }: { sessionId: string }) {
  const night = useLiveSession(sessionId);

  return (
    <div
      data-live={night.live}
      data-status={night.data?.status}
      className="flex flex-1 flex-col"
      data-testid="night-screen"
    >
      {night.isPending ? (
        <PhoneScreen title="Movie night">
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading the night"
            className="grid grid-cols-2 gap-3"
          >
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        </PhoneScreen>
      ) : night.isError ? (
        <PhoneScreen title="Movie night">
          {night.error.status === 401 ? (
            <div role="alert" className="flex flex-col gap-2 rounded-xl bg-card p-5 text-lg">
              <p>This phone hasn&apos;t joined tonight yet.</p>
              <p className="text-muted-foreground">
                Scan the QR code on the TV, then enter the night code.
              </p>
            </div>
          ) : (
            <ApiErrorNotice error={night.error} />
          )}
        </PhoneScreen>
      ) : (
        <NightState night={night.data} live={night.live} />
      )}
    </div>
  );
}

function NightState({ night, live }: { night: Night; live: LiveState }) {
  switch (night.status) {
    case "draft":
      return (
        <PhoneScreen title="Almost ready" lede="The host is still picking tonight's movies.">
          <p className="flex items-center gap-2 text-lg text-muted-foreground">
            <Clock aria-hidden className="size-5" />
            This screen updates by itself when voting opens.
          </p>
        </PhoneScreen>
      );
    case "voting":
      return <VotingFlow night={night} />;
    case "revealed":
      return (
        <PhoneScreen title="The winner is…">
          <WinnerCard night={night} />
          <Results night={night} />
        </PhoneScreen>
      );
    case "tonight":
      return (
        <PhoneScreen title="Tonight">
          <WinnerCard night={night} compact />
          <PhotoAlbum sessionId={night.id} live={live} />
          <RateLater night={night} />
        </PhoneScreen>
      );
    case "closed":
      return (
        <PhoneScreen title="That's a wrap" lede="Thanks for movie night.">
          <WinnerCard night={night} compact />
          <RatingPanel night={night} />
          <Results night={night} />
          <PhotoAlbum sessionId={night.id} live={live} />
          <Link
            href="/history"
            className={cn(buttonVariants({ variant: "outline", size: "tap" }), "w-full")}
          >
            Past movie nights
          </Link>
        </PhoneScreen>
      );
  }
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * Nobody rates during the movie: `tonight` keeps the stars folded away behind "Rate now", and
 * the home card asks "How was it?" next time the phone opens the app (04-frontend.md).
 */
function RateLater({ night }: { night: Night }) {
  const [opened, setOpened] = useState(false);
  // The home card's "Rate it" links here with #rate: open straight away.
  const asked = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash === "#rate",
    () => false,
  );
  if (opened || asked) return <RatingPanel night={night} />;
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
      <p className="text-lg">Rate later: we&apos;ll ask how it was after the movie.</p>
      <Button variant="outline" size="tap" className="w-full" onClick={() => setOpened(true)}>
        Rate it now
      </Button>
    </div>
  );
}
