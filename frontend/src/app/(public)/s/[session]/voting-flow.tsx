"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useReducer, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PhoneScreen } from "@/components/phone-screen";
import { Poster } from "@/components/poster";
import { Button, buttonVariants } from "@/components/ui/button";
import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError, type Night, type OwnBallot, type Person } from "@/lib/api";
import { ballotReducer, canSubmit, initialBallot, rankOf, toRanks } from "@/lib/ballot";
import { cn } from "@/lib/utils";

const PEOPLE = ["people"] as const;
const ballotsKey = (sessionId: string) => ["ballots", sessionId] as const;

type Cast = { personId: string; ranks: { option_id: string; rank: number }[] };

/**
 * Voting: pick who is voting (only when this phone holds several people), rank posters, Done,
 * then "Pass to next person" back to the grid (04-frontend.md "Ballot"). Ballots are replaceable
 * until close, so a person who already voted can change their picks.
 */
export function VotingFlow({ night }: { night: Night }) {
  const queryClient = useQueryClient();
  const people = useQuery<Person[], ApiError>({ queryKey: PEOPLE, queryFn: api.people });
  const ballots = useQuery<OwnBallot[], ApiError>({
    queryKey: ballotsKey(night.id),
    queryFn: () => api.myBallots(night.id),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<string | null>(null);

  const cast = useMutation<void, ApiError, Cast>({
    mutationFn: ({ personId, ranks }) => api.castBallot(night.id, { person_id: personId, ranks }),
    onSuccess: async (_, { personId }) => {
      await queryClient.invalidateQueries({ queryKey: ballotsKey(night.id) });
      setDoneFor(personId);
    },
    onError: () => {
      // The answer may mean the world moved on (voting closed, binding removed): catch up.
      void queryClient.invalidateQueries({ queryKey: nightKey(night.id) });
      void queryClient.invalidateQueries({ queryKey: PEOPLE });
    },
  });

  if (people.isPending || ballots.isPending) {
    return (
      <PhoneScreen title="Vote">
        <p className="text-lg text-muted-foreground">Loading…</p>
      </PhoneScreen>
    );
  }
  if (people.isError || ballots.isError) {
    return (
      <PhoneScreen title="Vote">
        <ApiErrorNotice error={people.error ?? ballots.error} />
      </PhoneScreen>
    );
  }

  const mine = people.data.filter((p) => p.binding === "mine");
  const saved = new Map(ballots.data.map((b) => [b.person_id, b.ranks]));
  const voter = mine.find((p) => p.id === (chosen ?? (mine.length === 1 ? mine[0].id : null)));
  const error = <ApiErrorNotice error={cast.error} />;

  if (mine.length === 0) {
    return (
      <PhoneScreen title="Vote" lede="Tell us who you are first.">
        {error}
        <Link href="/who" className={cn(buttonVariants({ size: "tap" }), "w-full")}>
          Pick who you are
        </Link>
      </PhoneScreen>
    );
  }

  if (!voter) {
    return (
      <PhoneScreen title="Who's voting?" lede="Tap your picture, then rank the movies.">
        {error}
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {mine.map((person) => {
            const voted = (saved.get(person.id)?.length ?? 0) > 0;
            return (
              <li key={person.id}>
                <button
                  type="button"
                  data-voted={voted}
                  onClick={() => {
                    cast.reset();
                    setDoneFor(null);
                    setChosen(person.id);
                  }}
                  className="flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl bg-card p-3 text-center ring-1 ring-foreground/10 transition-transform outline-none focus-visible:ring-3 focus-visible:ring-ring active:scale-[0.98]"
                >
                  <Avatar person={person} />
                  <span className="text-lg leading-tight font-medium">{person.name}</span>
                  {voted ? (
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Check aria-hidden className="size-4" />
                      Voted
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PhoneScreen>
    );
  }

  const savedRanks = saved.get(voter.id) ?? [];
  const passOn = () => {
    cast.reset();
    setDoneFor(null);
    setChosen(null);
  };

  if (doneFor === voter.id && savedRanks.length > 0) {
    const titles = new Map(night.options.map((o) => [o.id, o.title]));
    return (
      <PhoneScreen title={`Thanks, ${voter.name}!`} lede="Your picks are in.">
        <ol className="flex flex-col gap-2" data-testid="saved-picks">
          {[...savedRanks]
            .sort((a, b) => a.rank - b.rank)
            .map((r) => (
              <li
                key={r.option_id}
                className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-lg ring-1 ring-foreground/10"
              >
                <RankBadge rank={r.rank} />
                {titles.get(r.option_id)}
              </li>
            ))}
        </ol>
        <p className="text-muted-foreground">The winner shows here when the host closes voting.</p>
        <div className="flex flex-col gap-3">
          {mine.length > 1 ? (
            <Button size="tap" className="w-full" onClick={passOn}>
              Pass to next person
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="tap"
            className="w-full"
            onClick={() => {
              cast.reset();
              setDoneFor(null);
            }}
          >
            Change my picks
          </Button>
        </div>
      </PhoneScreen>
    );
  }

  return (
    <BallotForm
      // A fresh reducer per voter, starting from what they already saved.
      key={voter.id}
      night={night}
      voter={voter}
      savedRanks={savedRanks}
      error={error}
      busy={cast.isPending}
      canSwitch={mine.length > 1}
      onSwitch={passOn}
      onSubmit={(ranks) => cast.mutate({ personId: voter.id, ranks })}
    />
  );
}

function BallotForm({
  night,
  voter,
  savedRanks,
  error,
  busy,
  canSwitch,
  onSwitch,
  onSubmit,
}: {
  night: Night;
  voter: Person;
  savedRanks: { option_id: string; rank: number }[];
  error: React.ReactNode;
  busy: boolean;
  canSwitch: boolean;
  onSwitch: () => void;
  onSubmit: (ranks: { option_id: string; rank: number }[]) => void;
}) {
  const size = night.ballot_size ?? 0;
  const [ballot, dispatch] = useReducer(ballotReducer, size, (k) =>
    ballotReducer(initialBallot(k), { type: "load", ranks: savedRanks }),
  );
  const options = [...night.options].sort((a, b) => a.position - b.position);

  return (
    <PhoneScreen
      title="Rank your favourites"
      lede={
        size === 1
          ? "Tap the one you want to watch."
          : `Tap your favourite first, then your next. Up to ${size} picks.`
      }
    >
      <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
        <span className="flex items-center gap-3 text-lg">
          <Avatar person={voter} small />
          <span>
            Voting as <strong data-testid="voting-as">{voter.name}</strong>
          </span>
        </span>
        {canSwitch ? (
          <Button variant="ghost" size="tap" onClick={onSwitch}>
            Not you?
          </Button>
        ) : null}
      </div>

      <p aria-live="polite" className="text-muted-foreground" data-testid="pick-count">
        {ballot.picks.length} of {size} picked
      </p>

      <ul className="grid grid-cols-2 gap-3">
        {options.map((option) => {
          const rank = rankOf(ballot, option.id);
          return (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={rank !== null}
                data-rank={rank ?? undefined}
                onClick={() => dispatch({ type: "tap", optionId: option.id })}
                className={cn(
                  "relative flex w-full flex-col gap-2 rounded-2xl p-1.5 text-left ring-1 ring-foreground/10 transition-transform outline-none focus-visible:ring-3 focus-visible:ring-ring active:scale-[0.98]",
                  rank !== null && "ring-3 ring-foreground",
                )}
              >
                <Poster title={option.title} posterPath={option.poster_path} />
                <span className="px-1 pb-1 text-base leading-tight font-medium">
                  {option.title}
                  {option.year ? (
                    <span className="text-muted-foreground"> ({option.year})</span>
                  ) : null}
                </span>
                {rank !== null ? (
                  <span className="absolute top-3 left-3">
                    <RankBadge rank={rank} />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {error}

      <div className="sticky bottom-0 -mx-5 bg-background/90 px-5 py-4 backdrop-blur">
        <Button
          size="tap"
          className="w-full"
          disabled={!canSubmit(ballot) || busy}
          onClick={() => onSubmit(toRanks(ballot))}
        >
          {busy ? "Saving…" : "Done"}
        </Button>
      </div>
    </PhoneScreen>
  );
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <span className="flex size-9 items-center justify-center rounded-full bg-foreground text-lg font-semibold text-background">
      <span className="sr-only">Pick </span>
      {rank}
    </span>
  );
}

function Avatar({ person, small = false }: { person: Person; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-full",
        small ? "size-10 text-2xl" : "size-20 text-5xl",
      )}
      style={{ backgroundColor: `color-mix(in oklch, ${person.color} 45%, transparent)` }}
    >
      {person.avatar_emoji}
    </span>
  );
}
