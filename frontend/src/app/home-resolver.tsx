"use client";

import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { RatePromptCard } from "@/components/night/rate-prompt-card";
import { CurrentChip } from "@/components/night/switch-sheet";
import { PhoneScreen } from "@/components/phone-screen";
import { buttonVariants } from "@/components/ui/button";
import { useLiveNight, usePhonePeople } from "@/hooks/use-phone";
import { type LastJoin, parseLastJoin, readLastJoinRaw, rejoinLabel } from "@/lib/last-join";
import { resolve } from "@/lib/who";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};

/**
 * `/`, the phone's resolver (guest-flow spec §3): the one place that decides where a phone goes.
 * No device → S0 (or S1's rejoin link when this browser joined before); nobody current → /who;
 * a live night → /s/{id}; otherwise S8 "No movie night yet", which moves on by itself.
 */
export function HomeResolver() {
  const router = useRouter();
  const { people, current, noDevice } = usePhonePeople();
  const live = useLiveNight(people.isSuccess);
  const lastJoin = parseLastJoin(useSyncExternalStore(noSubscribe, readLastJoinRaw, () => null));

  const resolution = people.data && live.isSuccess ? resolve(people.data, live.data[0]) : null;
  const target =
    resolution?.screen === "who"
      ? "/who"
      : resolution?.screen === "night"
        ? `/s/${resolution.sessionId}`
        : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (noDevice) return <Landing lastJoin={lastJoin} />;

  if (people.isError) {
    return (
      <PhoneScreen title="Family Night Hub">
        <ApiErrorNotice error={people.error} />
      </PhoneScreen>
    );
  }
  if (live.isError) {
    return (
      <PhoneScreen title="Family Night Hub">
        <ApiErrorNotice error={live.error} />
      </PhoneScreen>
    );
  }

  if (resolution?.screen === "no-night" && people.data && current) {
    return (
      <PhoneScreen title="No movie night yet">
        <div data-screen="no-night" data-testid="waiting" className="flex flex-col gap-5">
          <CurrentChip current={current} people={people.data} verb="Hi," />
          <p aria-live="polite" className="text-lg text-muted-foreground">
            When the host starts one, this screen changes by itself.
          </p>
          <RatePromptCard />
          <div className="flex flex-col gap-3">
            <Link
              href="/history"
              className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
            >
              Past movie nights
            </Link>
            <Link
              href="/me"
              className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
            >
              My profile
            </Link>
          </div>
        </div>
      </PhoneScreen>
    );
  }

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

/** S0, or S1's rejoin link for a phone whose cookie was cleared (spec §5 S0, AC-1.6). */
function Landing({ lastJoin }: { lastJoin: LastJoin | null }) {
  return (
    <main
      data-screen="landing"
      className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center"
    >
      <Clapperboard aria-hidden className="size-14 text-cinema" />
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Family Night Hub</h1>
      <p className="text-lg text-muted-foreground">
        Scan the QR code on the fridge or the TV to join movie night.
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
