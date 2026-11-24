"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { buttonVariants } from "@/components/ui/button";
import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError, type Night, type OwnRating, type Person } from "@/lib/api";
import { NOT_ATTENDED, SCORES, describeAverage, mayRate } from "@/lib/rating";
import { cn } from "@/lib/utils";
import { actingPeople } from "@/lib/who";

const PEOPLE = ["people"] as const;
/** Keyed under the night, so every live event (incl. `rating_count`) refreshes it too. */
export const myRatingsKey = (sessionId: string) => ["night", sessionId, "ratings"] as const;

type Rate = { personId: string; score: number };

/**
 * "How was it?": five big stars for this phone's current person (04-frontend.md "Ratings";
 * ADR-0014: a phone rates only as its current person, so someone else on a shared phone switches
 * with the chip and their PIN first). Tapping a star saves that score at once; tapping another
 * replaces it. Below, the family average, never anyone else's own score. Someone who wasn't part
 * of the night (neither here nor voted, issue #91) gets `NOT_ATTENDED` instead of the stars.
 */
export function RatingPanel({ night }: { night: Night }) {
  const queryClient = useQueryClient();
  const people = useQuery<Person[], ApiError>({ queryKey: PEOPLE, queryFn: api.people });
  const ratings = useQuery<OwnRating[], ApiError>({
    queryKey: myRatingsKey(night.id),
    queryFn: () => api.myRatings(night.id),
  });
  const rate = useMutation<void, ApiError, Rate>({
    mutationFn: ({ personId, score }) => api.rate(night.id, { person_id: personId, score }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: nightKey(night.id) }),
    onError: () => void queryClient.invalidateQueries({ queryKey: PEOPLE }),
  });

  const title = night.options.find((o) => o.id === night.result?.winner_option_id)?.title;
  const average = describeAverage(night.rating);

  return (
    <section
      aria-labelledby="rate-heading"
      className="flex flex-col gap-4 rounded-2xl bg-card p-4 ring-1 ring-foreground/10"
      data-testid="rating-panel"
    >
      <h2 id="rate-heading" className="font-heading text-2xl font-semibold">
        How was {title ? <em>{title}</em> : "the movie"}?
      </h2>
      <ApiErrorNotice error={people.error ?? ratings.error ?? rate.error} />
      {people.isPending || ratings.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : people.data && ratings.data ? (
        <RatingRows
          people={actingPeople(people.data)}
          ratings={ratings.data}
          pending={rate.isPending ? rate.variables : undefined}
          onRate={(personId, score) => rate.mutate({ personId, score })}
        />
      ) : null}
      <p className="text-muted-foreground" data-testid="family-average" aria-live="polite">
        {average ? `Family average: ${average}` : "No ratings yet."}
      </p>
    </section>
  );
}

function RatingRows({
  people,
  ratings,
  pending,
  onRate,
}: {
  people: Person[];
  ratings: OwnRating[];
  pending: Rate | undefined;
  onRate: (personId: string, score: number) => void;
}) {
  if (people.length === 0) {
    return (
      <Link href="/who" className={cn(buttonVariants({ size: "tap" }), "w-full")}>
        Pick who you are
      </Link>
    );
  }
  const saved = new Map(ratings.map((r) => [r.person_id, r.score]));
  return (
    <ul className="flex flex-col gap-4">
      {people.map((person) => {
        const shown =
          pending?.personId === person.id ? pending.score : (saved.get(person.id) ?? null);
        const label = (
          <span className="flex items-center gap-2 text-lg font-medium" id={`rate-${person.id}`}>
            <Avatar emoji={person.avatar_emoji} color={person.color} className="size-9 text-xl" />
            {person.name}
          </span>
        );
        if (!mayRate(ratings, person.id)) {
          return (
            <li key={person.id} className="flex flex-col gap-2" data-testid="rating-row">
              {label}
              <p className="text-muted-foreground" data-testid="rating-not-attended">
                {NOT_ATTENDED}
              </p>
            </li>
          );
        }
        return (
          <li key={person.id} className="flex flex-col gap-2" data-testid="rating-row">
            {label}
            <div
              role="radiogroup"
              aria-labelledby={`rate-${person.id}`}
              className="flex justify-between gap-1"
            >
              {SCORES.map((score) => {
                const on = shown !== null && score <= shown;
                return (
                  <button
                    key={score}
                    type="button"
                    role="radio"
                    aria-checked={shown === score}
                    aria-label={`${score} ${score === 1 ? "star" : "stars"}`}
                    onClick={() => onRate(person.id, score)}
                    className={cn(
                      "flex size-14 items-center justify-center rounded-xl ring-1 ring-foreground/15 transition-transform outline-none focus-visible:ring-3 focus-visible:ring-ring active:scale-95",
                      on ? "bg-foreground text-background" : "bg-background text-muted-foreground",
                    )}
                  >
                    <Star aria-hidden className={cn("size-7", on && "fill-current")} />
                  </button>
                );
              })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
