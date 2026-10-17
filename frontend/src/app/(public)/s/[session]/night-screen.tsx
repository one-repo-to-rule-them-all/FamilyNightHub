"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { HereTonight } from "@/components/night/here-tonight";
import { RatingPanel } from "@/components/night/rating-panel";
import { CurrentChip } from "@/components/night/switch-sheet";
import { PhoneScreen } from "@/components/phone-screen";
import { PhotoAlbum } from "@/components/photos/photo-album";
import { Button, buttonVariants } from "@/components/ui/button";
import { useLiveSession } from "@/hooks/use-live-session";
import { usePhonePeople } from "@/hooks/use-phone";
import type { Night, PersonTile } from "@/lib/api";
import type { LiveState } from "@/lib/live";
import { cn } from "@/lib/utils";

import { VotingFlow } from "./voting-flow";
import { Results, WinnerCard } from "./winner";

/**
 * /s/[session]: the phone's view of one night, driven by the snapshot's `status`
 * (04-frontend.md "Phone state machine"; guest-flow spec §5 S9–S14). It always acts as this
 * phone's current person (ADR-0014): without one, the resolver (`/`) sends the phone to /who.
 * `data-live` mirrors useLiveSession, so tests and the SSE hook agree on when the screen is live.
 */
export function NightScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const night = useLiveSession(sessionId);
  const { people, current, noDevice } = usePhonePeople();
  const nobody = noDevice || (people.isSuccess && !current);
  const status = night.data?.status;

  // "Voting just closed" when the snapshot flips under an open ballot (spec §5 S10).
  const [seen, setSeen] = useState(status);
  const [closedNotice, setClosedNotice] = useState(false);
  if (status !== seen) {
    setSeen(status);
    setClosedNotice(seen === "voting" && status === "revealed");
  }

  useEffect(() => {
    if (nobody) router.replace("/");
  }, [nobody, router]);

  return (
    <div
      data-live={night.live}
      data-status={status}
      className="flex flex-1 flex-col"
      data-testid="night-screen"
    >
      {night.isPending || people.isPending || nobody ? (
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
      ) : night.isError || people.isError ? (
        <PhoneScreen title="Movie night">
          <ApiErrorNotice error={night.error ?? people.error} />
        </PhoneScreen>
      ) : current ? (
        <NightState
          night={night.data}
          live={night.live}
          people={people.data}
          current={current}
          closedNotice={closedNotice}
        />
      ) : null}
    </div>
  );
}

function NightState({
  night,
  live,
  people,
  current,
  closedNotice,
}: {
  night: Night;
  live: LiveState;
  people: PersonTile[];
  current: PersonTile;
  closedNotice: boolean;
}) {
  const chip = <CurrentChip current={current} people={people} />;
  const here = (compact = false) => (
    <HereTonight night={night} live={live} people={people} selfId={current.id} compact={compact} />
  );

  switch (night.status) {
    case "draft":
      return (
        <PhoneScreen title="Almost ready">
          {chip}
          {here()}
          <div data-screen="almost-ready" data-testid="waiting">
            <p aria-live="polite" className="text-lg text-muted-foreground">
              The host is picking movies ({night.options.length} so far). Voting starts here by
              itself.
            </p>
          </div>
        </PhoneScreen>
      );
    case "voting":
      return <VotingFlow night={night} live={live} people={people} current={current} here={here} />;
    case "revealed":
      return (
        <PhoneScreen title="The winner is…">
          {chip}
          <div data-screen="winner" data-testid="waiting" className="flex flex-col gap-6">
            {closedNotice ? (
              <p role="status" className="rounded-xl bg-cinema-muted p-4 text-lg">
                Voting just closed. Here&apos;s the winner!
              </p>
            ) : null}
            <WinnerCard night={night} />
            <p aria-live="polite" className="text-lg text-muted-foreground">
              Get the snacks! Photos open in a moment.
            </p>
            <Results night={night} />
          </div>
        </PhoneScreen>
      );
    case "tonight":
      return (
        <PhoneScreen title="Tonight">
          {chip}
          <div data-screen="tonight" className="flex flex-col gap-6">
            <WinnerCard night={night} compact />
            {here()}
            <PhotoAlbum sessionId={night.id} live={live} actorId={current.id} />
            <RateIt night={night} />
          </div>
        </PhoneScreen>
      );
    case "closed":
      return (
        <PhoneScreen title="That's a wrap" lede="Thanks for movie night.">
          {chip}
          <div data-screen="rate" className="flex flex-col gap-6">
            <WinnerCard night={night} compact />
            <RatingPanel night={night} />
            <Results night={night} />
            <PhotoAlbum sessionId={night.id} live={live} actorId={current.id} />
            <Link
              href="/history"
              className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
            >
              Past movie nights
            </Link>
          </div>
        </PhoneScreen>
      );
  }
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * `tonight`'s rating, folded away (guest-flow spec §5 S13): **Already watched? Rate it** as a
 * `secondary` button (solid fill, full-contrast text) with no sentence above it. The outline
 * button under "Rate later: …" read as disabled on a dark phone (staging walkthrough, 2026-10-17).
 * The home card still asks "How was it?" after the movie.
 */
function RateIt({ night }: { night: Night }) {
  const [opened, setOpened] = useState(false);
  // The home card's "Rate it" links here with #rate: open straight away.
  const asked = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash === "#rate",
    () => false,
  );
  if (opened || asked) return <RatingPanel night={night} />;
  return (
    <Button
      variant="secondary"
      size="tap"
      className="w-full"
      data-variant="secondary"
      onClick={() => setOpened(true)}
    >
      Already watched? Rate it
    </Button>
  );
}
