"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { Poster } from "@/components/poster";
import { CurrentChip, SwitchSheet } from "@/components/night/switch-sheet";
import { Button } from "@/components/ui/button";
import { nightKey } from "@/hooks/use-live-session";
import { PEOPLE_KEY } from "@/hooks/use-phone";
import { useVoters } from "@/hooks/use-voters";
import { api, type ApiError, type Night, type OwnBallot, type PersonTile } from "@/lib/api";
import {
  ballotPrompt,
  ballotReducer,
  canSubmit,
  initialBallot,
  pickCount,
  rankOf,
  toRanks,
} from "@/lib/ballot";
import type { LiveState } from "@/lib/live";
import { cn } from "@/lib/utils";
import { phonePeople } from "@/lib/who";

import { clearBallotDraft, draftDiffers, readBallotDraft, writeBallotDraft } from "./ballot-draft";
import { ScreenTitle } from "./screen-title";

/**
 * Under the night's key, so every stream event refreshes it too: a person held by two phones
 * who votes on one must show as voted on the other (found by the sign-off e2e run, #42).
 */
const ballotsKey = (sessionId: string) => [...nightKey(sessionId), "ballots", "mine"] as const;

/** The ballot leaves the nav out (its sticky Done owns the bottom) and links back Home instead. */
const BALLOT_SHELL = {
  hideNav: true,
  handoff: "none",
  back: { href: "/", label: "Home" },
} as const;

type Cast = { personId: string; ranks: { option_id: string; rank: number }[] };

/**
 * Voting (guest-flow spec §5 S10–S11): the ballot is always for this phone's current person
 * (ADR-0014), so there is no "Who's voting?" grid any more (D5); a shared phone hands over with
 * **Pass to next person**, which opens the switch sheet and asks for the next person's PIN.
 * Ballots are replaceable until close, so a person who already voted can change their picks.
 * Guest home (§5 "Live-night screens"): picks-in (S11) sits in the shell with the nav; the ballot
 * (S10) has no nav, a **‹ Home** link, and keeps unsaved picks for this tab (`ballot-draft.ts`).
 */
export function VotingFlow({
  night,
  live,
  people,
  current,
  here,
}: {
  night: Night;
  live: LiveState;
  people: PersonTile[];
  current: PersonTile;
  here: (compact?: boolean) => React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const ballots = useQuery<OwnBallot[], ApiError>({
    queryKey: ballotsKey(night.id),
    queryFn: () => api.myBallots(night.id),
  });
  const voters = useVoters(night.id, true, live);
  const [editing, setEditing] = useState(false);
  const [passing, setPassing] = useState(false);
  const [switching, setSwitching] = useState(false);

  const cast = useMutation<void, ApiError, Cast>({
    mutationFn: ({ personId, ranks }) => api.castBallot(night.id, { person_id: personId, ranks }),
    onSuccess: async (_, { personId }) => {
      clearBallotDraft(night.id, personId);
      await queryClient.invalidateQueries({ queryKey: ballotsKey(night.id) });
      setEditing(false);
    },
    onError: () => {
      // The answer may mean the world moved on (voting closed, binding removed): catch up.
      void queryClient.invalidateQueries({ queryKey: nightKey(night.id) });
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
    },
  });

  const saved = new Map((ballots.data ?? []).map((b) => [b.person_id, b.ranks]));
  const votedIds = new Set([...saved].filter(([, ranks]) => ranks.length > 0).map(([id]) => id));
  // The chip shows in the loading view and again in the ballot: its sheet's open state lives
  // here, so a tap while ballots load isn't lost when the ballot replaces the loading view.
  const chip = (
    <CurrentChip
      current={current}
      people={people}
      votedIds={votedIds}
      open={switching}
      onOpenChange={setSwitching}
    />
  );

  if (ballots.isPending) {
    return (
      <GuestShell screen="ballot" {...BALLOT_SHELL}>
        <ScreenTitle title="Vote" />
        {chip}
        <p className="text-lg text-muted-foreground">Loading…</p>
      </GuestShell>
    );
  }
  if (ballots.isError) {
    return (
      <GuestShell screen="ballot" {...BALLOT_SHELL}>
        <ScreenTitle title="Vote" />
        {chip}
        <ApiErrorNotice error={ballots.error} />
      </GuestShell>
    );
  }

  const savedRanks = saved.get(current.id) ?? [];
  const nextUp = phonePeople(people).some(
    (p) => p.id !== current.id && !votedIds.has(p.id) && !p.locked,
  );

  // Back from Home with unsaved changes to saved picks: reopen the ballot where it was left.
  const resume = draftDiffers(readBallotDraft(night.id, current.id), savedRanks);

  if (savedRanks.length > 0 && !editing && !resume) {
    const titles = new Map(night.options.map((o) => [o.id, o.title]));
    const voted = voters.data?.length ?? votedIds.size;
    return (
      <GuestShell screen="picks-in" handoff="none">
        <ScreenTitle title={`Thanks, ${current.name}!`} lede="Your picks are in." />
        {chip}
        {here()}
        <div data-testid={nextUp ? undefined : "waiting"} className="flex flex-col gap-5">
          <ol className="flex flex-col gap-2" data-testid="saved-picks">
            {[...savedRanks]
              .sort((a, b) => a.rank - b.rank)
              .map((r) => (
                <li
                  key={r.option_id}
                  className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-lg ring-1 ring-foreground/10"
                >
                  {night.voting_method === "top3" ? <RankBadge rank={r.rank} /> : <PickedBadge />}
                  {titles.get(r.option_id)}
                </li>
              ))}
          </ol>
          <p aria-live="polite" className="text-lg text-muted-foreground" data-testid="voted-count">
            <strong className="text-foreground">
              {voted} of {people.length}
            </strong>{" "}
            voted. The winner shows here when voting closes.
          </p>
          <div className="flex flex-col gap-3">
            {nextUp ? (
              <Button
                size="tap"
                className="w-full"
                data-testid="primary-action"
                onClick={() => setPassing(true)}
              >
                Pass to next person
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="tap"
              className="w-full"
              onClick={() => {
                cast.reset();
                setEditing(true);
              }}
            >
              Change my picks
            </Button>
          </div>
        </div>
        {passing ? (
          <SwitchSheet
            people={people}
            current={current}
            votedIds={votedIds}
            onClose={() => setPassing(false)}
          />
        ) : null}
      </GuestShell>
    );
  }

  return (
    <BallotForm
      // A fresh reducer per voter, starting from what they already saved.
      key={current.id}
      night={night}
      personId={current.id}
      savedRanks={savedRanks}
      header={
        <>
          {chip}
          {here(true)}
        </>
      }
      error={<ApiErrorNotice error={cast.error} />}
      busy={cast.isPending}
      onSubmit={(ranks) => cast.mutate({ personId: current.id, ranks })}
    />
  );
}

function BallotForm({
  night,
  personId,
  savedRanks,
  header,
  error,
  busy,
  onSubmit,
}: {
  night: Night;
  personId: string;
  savedRanks: { option_id: string; rank: number }[];
  header: React.ReactNode;
  error: React.ReactNode;
  busy: boolean;
  onSubmit: (ranks: { option_id: string; rank: number }[]) => void;
}) {
  const size = night.ballot_size ?? 0;
  const ranked = night.voting_method === "top3";
  const [ballot, dispatch] = useReducer(ballotReducer, size, (k) =>
    ballotReducer(initialBallot(k, night.voting_method), {
      type: "load",
      ranks: readBallotDraft(night.id, personId) ?? savedRanks,
    }),
  );
  // Every change is kept for this tab, so ‹ Home and back restores it (cleared once saved).
  useEffect(() => {
    writeBallotDraft(night.id, personId, toRanks(ballot));
  }, [ballot, night.id, personId]);
  const options = [...night.options].sort((a, b) => a.position - b.position);
  const prompt = ballotPrompt(ballot);

  return (
    <GuestShell screen="ballot" {...BALLOT_SHELL}>
      <ScreenTitle title={prompt.title} lede={prompt.lede} />
      {header}

      <p aria-live="polite" className="text-muted-foreground" data-testid="pick-count">
        {pickCount(ballot)}
      </p>

      <ul className="grid grid-cols-2 gap-3" data-method={night.voting_method}>
        {options.map((option) => {
          const rank = rankOf(ballot, option.id);
          return (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={rank !== null}
                data-rank={ranked ? (rank ?? undefined) : undefined}
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
                    {ranked ? <RankBadge rank={rank} /> : <PickedBadge />}
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
          data-testid="primary-action"
          disabled={!canSubmit(ballot) || busy}
          onClick={() => onSubmit(toRanks(ballot))}
        >
          {busy ? "Saving…" : "Done"}
        </Button>
      </div>
    </GuestShell>
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

function PickedBadge() {
  return (
    <span className="flex size-9 items-center justify-center rounded-full bg-foreground text-background">
      <Check aria-hidden className="size-5" />
      <span className="sr-only">Picked</span>
    </span>
  );
}
