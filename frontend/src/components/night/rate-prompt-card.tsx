"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";

import { myRatingsKey } from "@/components/night/rating-panel";
import { Poster } from "@/components/poster";
import { Button, buttonVariants } from "@/components/ui/button";
import { api, type ApiError, type NightSummary, type OwnRating, type Person } from "@/lib/api";
import { dismissRatePrompt, isRatePromptDismissed, unratedPeople } from "@/lib/rating";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};

/**
 * "How was *Movie*?" on a phone's landing screens (04-frontend.md "Phone state machine"): nobody
 * rates during the movie, so the next time this phone opens the app it asks about the most recent
 * `tonight`/`closed` night, for as long as someone this phone holds hasn't rated it. "Not now"
 * hides it for that night on this phone. Without a device (401) it renders nothing.
 */
export function RatePromptCard() {
  const latest = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "rate-prompt"],
    queryFn: () => api.nights({ status: ["tonight", "closed"], limit: 1 }),
    retry: false,
  });
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
  const storedDismissal = useSyncExternalStore(
    noSubscribe,
    () => (night ? isRatePromptDismissed(night.id) : false),
    () => true, // the server can't know: render nothing until the browser has checked
  );
  const [dismissedNow, setDismissedNow] = useState<string | null>(null);

  if (!night || !people.data || !ratings.data) return null;
  if (storedDismissal || dismissedNow === night.id) return null;
  const waiting = unratedPeople(people.data, ratings.data);
  if (waiting.length === 0) return null;

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
            onClick={() => {
              dismissRatePrompt(night.id);
              setDismissedNow(night.id);
            }}
          >
            <X aria-hidden className="size-6" />
          </Button>
        </div>
        <Link
          href={`/s/${night.id}#rate`}
          className={cn(buttonVariants({ size: "tap" }), "w-full")}
          data-testid="rate-prompt-go"
        >
          {waiting.length === 1 ? `Rate it, ${waiting[0].name}` : "Rate it"}
        </Link>
      </div>
    </section>
  );
}
