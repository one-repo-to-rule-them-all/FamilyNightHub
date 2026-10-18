"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";

import { myRatingsKey } from "@/components/night/rating-panel";
import { Poster } from "@/components/poster";
import { Button, buttonVariants } from "@/components/ui/button";
import { api, type ApiError, type NightSummary, type OwnRating, type Person } from "@/lib/api";
import { dismissRatePrompt, isRatePromptDismissed, unratedPeople } from "@/lib/rating";
import { cn } from "@/lib/utils";

/** The household's newest `tonight`/`closed` night: the one to rate, and Home's photo strip. */
export const latestWatchedNightQuery = {
  queryKey: ["nights", "rate-prompt"] as const,
  queryFn: () => api.nights({ status: ["tonight", "closed"], limit: 1 }),
};

/** Every mounted prompt re-reads its dismissal when one of them taps "Not now". */
const dismissListeners = new Set<() => void>();
function subscribeDismissals(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

export type RatePrompt = {
  night: NightSummary;
  /** Who on this phone hasn't rated it yet (never empty). */
  waiting: Person[];
  dismiss: () => void;
};

/**
 * The rating this phone still owes (04-frontend.md "Phone state machine"): the most recent
 * `tonight`/`closed` night, for as long as someone this phone holds hasn't rated it and "Not now"
 * wasn't tapped for it on this phone. Null while loading, without a device (401), or when nothing
 * is owed. Home's Tonight card (T7) and `RatePromptCard` share it.
 */
export function useRatePrompt(): RatePrompt | null {
  const latest = useQuery<NightSummary[], ApiError>({ ...latestWatchedNightQuery, retry: false });
  const night = latest.data?.[0];
  const people = useQuery<Person[], ApiError>({
    queryKey: ["people"],
    queryFn: api.people,
    enabled: night !== undefined,
  });
  const nightId = night?.id ?? "";
  const ratings = useQuery<OwnRating[], ApiError>({
    queryKey: myRatingsKey(nightId),
    queryFn: () => api.myRatings(nightId),
    enabled: night !== undefined,
  });
  const dismissed = useSyncExternalStore(
    subscribeDismissals,
    () => (night ? isRatePromptDismissed(night.id) : false),
    () => true, // the server can't know: render nothing until the browser has checked
  );
  const dismiss = useCallback(() => {
    if (!nightId) return;
    dismissRatePrompt(nightId);
    for (const listener of dismissListeners) listener();
  }, [nightId]);

  if (!night || !people.data || !ratings.data || dismissed) return null;
  const waiting = unratedPeople(people.data, ratings.data);
  if (waiting.length === 0) return null;
  return { night, waiting, dismiss };
}

/**
 * "How was *Movie*?" on a phone's landing screens: nobody rates during the movie, so the next time
 * this phone opens the app it asks about the night `useRatePrompt` finds. "Not now" hides it for
 * that night on this phone. On Home the Tonight card owns the primary, so Home passes
 * `variant="secondary"`.
 */
export function RatePromptCard({ variant = "default" }: { variant?: "default" | "secondary" }) {
  const prompt = useRatePrompt();
  if (!prompt) return null;
  const { night, waiting, dismiss } = prompt;

  const title = night.winner?.title ?? "movie night";
  return (
    <section
      aria-labelledby="rate-prompt-heading"
      className="flex items-center gap-4 rounded-2xl bg-card p-4 text-left ring-1 ring-foreground/10"
      data-testid="rate-prompt"
    >
      <Poster
        title={title}
        posterPath={night.winner?.poster_path ?? null}
        className="w-16 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <h2 id="rate-prompt-heading" className="font-heading text-xl leading-tight font-semibold">
            How was <em>{title}</em>?
          </h2>
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Not now"
            className="size-14 shrink-0"
            onClick={dismiss}
          >
            <X aria-hidden className="size-6" />
          </Button>
        </div>
        <Link
          href={`/s/${night.id}#rate`}
          className={cn(buttonVariants({ variant, size: "tap" }), "w-full")}
          data-testid="rate-prompt-go"
        >
          {waiting.length === 1 ? `Rate it, ${waiting[0].name}` : "Rate it"}
        </Link>
      </div>
    </section>
  );
}
