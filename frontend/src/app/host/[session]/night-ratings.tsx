"use client";

import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import type { LiveState } from "@/hooks/use-live-session";
import { useVoters } from "@/hooks/use-voters";
import { api, type ApiError, type Night, type Person } from "@/lib/api";
import { describeAverage, ratingProgress } from "@/lib/rating";

/**
 * P6 Ratings (owner-portal.md): read-only, the target of the inbox's `unrated` row. How many of
 * the people who watched have rated, and the family average. The API never exposes anyone's own
 * score (03-backend.md "Ratings"), and has no "who has rated" list yet, so the panel names who
 * watched (the voters) rather than who is missing. The snapshot's `rating` is live, so the count
 * moves as phones rate.
 */
export function NightRatings({ night, live }: { night: Night; live: LiveState }) {
  const voters = useVoters(night.id, true, live);
  // Same device-scoped people list the voting panel uses; without it the avatars stand alone.
  const people = useQuery<Person[], ApiError>({ queryKey: ["people"], queryFn: api.people });
  const names = new Map(people.data?.map((p) => [p.id, p.name]));
  const turnout = night.result?.ballot_count ?? voters.data?.length ?? 0;
  const progress = ratingProgress(night.rating, turnout);
  const average = describeAverage(night.rating);
  const watched = voters.data ?? [];

  return (
    <section
      aria-labelledby="night-ratings-heading"
      className="flex flex-col gap-4 rounded-2xl bg-card p-4 ring-1 ring-foreground/10"
      data-testid="night-ratings"
      data-rated={progress.rated}
      data-of={progress.of}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="night-ratings-heading" className="flex items-center gap-2 text-xl font-semibold">
          <Star aria-hidden className="size-5 text-cinema" /> Ratings
        </h2>
        <p data-testid="night-ratings-progress">
          {progress.of === 0 ? (
            "No ratings yet."
          ) : (
            <>
              <strong>
                {progress.rated} of {progress.of}
              </strong>{" "}
              rated
            </>
          )}
        </p>
      </div>
      <p className="text-muted-foreground">
        {average ? `Family average: ${average}.` : "Nobody has rated it yet."}{" "}
        {progress.done
          ? "Everyone who watched has rated."
          : "Phones ask everyone who watched; only the family average is shown, never anyone's own score."}
      </p>
      <ApiErrorNotice error={voters.error} />
      {watched.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Who watched</h3>
          <ul className="flex flex-wrap gap-3" aria-label="Who watched">
            {watched.map((v) => (
              <li
                key={v.person_id}
                className="flex flex-col items-center gap-1"
                aria-label={names.get(v.person_id) ?? "Someone"}
              >
                <Avatar emoji={v.avatar_emoji} color={v.color} className="size-12 text-2xl" />
                {names.has(v.person_id) ? (
                  <span aria-hidden className="text-sm text-muted-foreground">
                    {names.get(v.person_id)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
