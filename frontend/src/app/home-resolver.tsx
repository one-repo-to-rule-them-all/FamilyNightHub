"use client";

import { useQuery } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useSyncExternalStore } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { PhotoStrip } from "@/components/home/photo-strip";
import { RecentNights } from "@/components/home/recent-nights";
import { castBallots, homeBallotsKey, Tonight } from "@/components/home/tonight-card";
import { RatePromptCard, useRatePrompt } from "@/components/night/rate-prompt-card";
import { PhoneScreen } from "@/components/phone-screen";
import { buttonVariants } from "@/components/ui/button";
import { markNightSeen, useHouseholdNight } from "@/hooks/use-household-night";
import { useLiveNight, usePhonePeople } from "@/hooks/use-phone";
import { api, type ApiError, type OwnBallot, type PersonTile } from "@/lib/api";
import { DEVICE_EXPIRED_COPY } from "@/lib/device-idle";
import { arrivalTarget, coldOpenTarget, HOME_COPY } from "@/lib/home";
import { type LastJoin, parseLastJoin, readLastJoinRaw, rejoinLabel } from "@/lib/last-join";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};

/**
 * A cold open is the first Home mount of this page load (guest-home §3.3 rule 2): opening the app,
 * a reload, a link from outside. A module-level flag survives in-app navigation but not a full
 * load, so tapping Home in the nav or a back link is never a cold open (AC-H2.3).
 */
let firstMount = true;

/** For tests: start the next render as a fresh page load. */
export function resetColdOpenForTests(): void {
  firstMount = true;
}

/**
 * The page load itself opened `/`. A load that opened `/s/{id}` (a shared link) and then tapped
 * Home is in-app navigation, not a cold open, even though it is Home's first mount.
 */
function loadedAtHome(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    return entry ? new URL(entry.name).pathname === "/" : true;
  } catch {
    return true;
  }
}

/**
 * `/`: the phone's front door (guest-flow §3) and, for a current person, Home (guest-home §5 H1).
 * No device → S0 (or S1's rejoin link when this browser joined before); a device unused for 30 days
 * (issue #56) → straight back to S1 at the door it came through; nobody current → /who. Those rules
 * are unchanged. A current person gets Home, which moves by itself only on an arrival
 * (`?arrive=1`) or a cold open while voting with no ballot from them (§3.3).
 */
export function HomeResolver() {
  // useSearchParams (?arrive=1) needs a Suspense boundary for the static shell.
  return (
    <Suspense fallback={<Loading />}>
      <Resolver />
    </Suspense>
  );
}

function Resolver() {
  const router = useRouter();
  const { people, current, noDevice, expired } = usePhonePeople();
  const lastJoin = parseLastJoin(useSyncExternalStore(noSubscribe, readLastJoinRaw, () => null));

  const target =
    expired && lastJoin
      ? `/j/${encodeURIComponent(lastJoin.slug)}`
      : people.data && !current
        ? "/who"
        : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (noDevice) return <Landing lastJoin={lastJoin} expired={expired} />;

  if (people.isError) {
    return (
      <PhoneScreen title="Family Night Hub">
        <ApiErrorNotice error={people.error} />
      </PhoneScreen>
    );
  }

  if (people.data && current) return <Home people={people.data} current={current} />;
  return <Loading />;
}

function Loading() {
  return (
    <PhoneScreen title="Family Night Hub">
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading"
        className="h-40 animate-pulse rounded-2xl bg-muted"
      />
    </PhoneScreen>
  );
}

/**
 * H1 Home (`data-screen="home"`): the greeting, the Tonight card (the one primary), the rating
 * prompt when the card isn't already asking, *My recent nights* and the family photo strip.
 */
function Home({ people, current }: { people: PersonTile[]; current: PersonTile }) {
  const router = useRouter();
  const arriving = useSearchParams().get("arrive") === "1";
  const live = useLiveNight(true);
  const { night, isNew } = useHouseholdNight(true);
  const ratePrompt = useRatePrompt();
  const voting = night?.status === "voting";
  const ballots = useQuery<OwnBallot[], ApiError>({
    queryKey: homeBallotsKey(night?.id ?? ""),
    queryFn: () => api.myBallots(night?.id ?? ""),
    enabled: voting,
  });

  // Read the flag on the first render; clear it once mounted, so only this mount is cold.
  const cold = useRef(firstMount);
  useEffect(() => {
    firstMount = false;
    if (!loadedAtHome()) cold.current = false;
  }, []);

  // Rule 1: an arrival jumps into the live night, else strips the parameter and stays. Home can
  // already be mounted (a switch from the Tonight card), so this follows `arriving`, not the mount.
  useEffect(() => {
    if (!arriving || !live.isSuccess) return;
    cold.current = false;
    if (night) markNightSeen(night.id);
    router.replace(arrivalTarget(night));
  }, [arriving, live.isSuccess, night, router]);

  // Rule 2, decided once the facts are in; after that Home never moves by itself (rule 4).
  useEffect(() => {
    if (arriving || !cold.current || !live.isSuccess) return;
    if (voting && ballots.isPending) return;
    cold.current = false;
    const votedByCurrent = castBallots(ballots.data).some((b) => b.person_id === current.id);
    const to = coldOpenTarget({ firstMount: true, night, votedByCurrent });
    if (to && night) {
      markNightSeen(night.id);
      router.replace(to);
    }
  }, [
    arriving,
    live.isSuccess,
    voting,
    ballots.isPending,
    ballots.data,
    current.id,
    night,
    router,
  ]);

  // A new night buzzes once (§3.3 rule 4), where the phone supports it.
  const buzzed = useRef<string | null>(null);
  useEffect(() => {
    if (!isNew || !night || buzzed.current === night.id) return;
    buzzed.current = night.id;
    try {
      navigator.vibrate?.(40);
    } catch {
      // Not allowed (no user gesture yet, or blocked): the chip and the announcement still show.
    }
  }, [isNew, night]);

  // The card asks for the rating itself in T6 and T7; only otherwise the separate prompt shows.
  const cardAsks = night ? night.status === "tonight" : ratePrompt !== null;

  return (
    <GuestShell screen="home" handoff="none">
      <h1 className="font-heading text-3xl font-semibold tracking-tight" data-testid="home-hi">
        {HOME_COPY.home.hi} <strong>{current.name}</strong>
      </h1>
      {live.isError ? (
        <ApiErrorNotice error={live.error} />
      ) : live.isSuccess ? (
        <Tonight
          night={night}
          isNew={isNew}
          people={people}
          current={current}
          ratePrompt={ratePrompt}
        />
      ) : (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading"
          className="h-48 animate-pulse rounded-2xl bg-muted"
        />
      )}
      {cardAsks ? null : <RatePromptCard variant="secondary" />}
      <RecentNights personId={current.id} />
      <PhotoStrip />
    </GuestShell>
  );
}

/** S0, or S1's rejoin link for a phone whose cookie was cleared (spec §5 S0, AC-1.6). */
function Landing({ lastJoin, expired }: { lastJoin: LastJoin | null; expired: boolean }) {
  return (
    <main
      data-screen="landing"
      className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center"
    >
      <Clapperboard aria-hidden className="size-14 text-cinema" />
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Family Night Hub</h1>
      <p className="text-lg text-muted-foreground" data-testid="landing-lede">
        {expired
          ? DEVICE_EXPIRED_COPY.landing
          : "Scan the QR code on the fridge or the TV to join movie night."}
      </p>
      {lastJoin ? (
        <Link
          href={`/j/${encodeURIComponent(lastJoin.slug)}`}
          className={cn(buttonVariants({ size: "tap" }), "w-full")}
          data-testid="primary-action"
        >
          {rejoinLabel(lastJoin)}
        </Link>
      ) : null}
      <Link href="/login" className="text-sm text-muted-foreground underline underline-offset-4">
        Hosting tonight? Sign in
      </Link>
    </main>
  );
}
