"use client";

import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/poster";
import { api, type ApiError, type NightSummary } from "@/lib/api";
import { describeAverage } from "@/lib/rating";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** GET /api/v1/sessions with the server's default filter: revealed, tonight and closed. */
export function HistoryList() {
  const nights = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "history"],
    queryFn: () => api.nights(),
  });

  if (nights.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading past nights"
        className="flex flex-col gap-3"
      >
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }
  if (nights.isError) {
    if (nights.error.status === 401) {
      return (
        <p role="alert" className="rounded-xl bg-card p-5 text-lg">
          Join a movie night on this phone to see your family&apos;s past nights.
        </p>
      );
    }
    return <ApiErrorNotice error={nights.error} />;
  }
  if (nights.data.length === 0) {
    return (
      <p className="text-lg text-muted-foreground">
        No movie nights yet. Tonight could be the first.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="history-list">
      {nights.data.map((night) => {
        const when = new Date(night.revealed_at ?? night.created_at);
        const average = describeAverage(night.rating);
        return (
          <li key={night.id}>
            <Link
              href={`/s/${night.id}`}
              className="flex items-center gap-4 rounded-2xl bg-card p-3 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <Poster
                title={night.winner?.title ?? "No winner"}
                posterPath={night.winner?.poster_path ?? null}
                className="w-20 shrink-0"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-lg leading-tight font-medium" data-testid="history-winner">
                  {night.winner?.title ?? "No winner"}
                </span>
                <time dateTime={when.toISOString()} className="text-muted-foreground">
                  {dateFormat.format(when)}
                </time>
                <span className="text-sm text-muted-foreground" data-testid="history-turnout">
                  {night.turnout} {night.turnout === 1 ? "person" : "people"} voted
                </span>
                {average ? (
                  <span className="flex items-center gap-1 text-sm" data-testid="history-rating">
                    <Star aria-hidden className="size-4 fill-current" />
                    <span className="sr-only">Family rating:</span> {average}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
