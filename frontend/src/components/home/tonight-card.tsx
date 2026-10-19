"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { profileKey } from "@/app/(public)/people/[id]/profile-view";
import { HereTonight } from "@/components/night/here-tonight";
import { latestWatchedNightQuery, type RatePrompt } from "@/components/night/rate-prompt-card";
import { SwitchSheet } from "@/components/night/switch-sheet";
import { Poster } from "@/components/poster";
import { Button, buttonVariants } from "@/components/ui/button";
import { markNightSeen } from "@/hooks/use-household-night";
import { nightKey, useLiveSession } from "@/hooks/use-live-session";
import { useVoters } from "@/hooks/use-voters";
import {
  api,
  type ApiError,
  type Night,
  type NightSummary,
  type OwnBallot,
  type PersonTile,
} from "@/lib/api";
import {
  HOME_COPY,
  nightHref,
  stillToVote,
  type TonightPrimary,
  type TonightState,
  tonightState,
} from "@/lib/home";
import { cn } from "@/lib/utils";

/** This phone's ballots for a night, keyed under it so every stream event refreshes them (§6). */
export const homeBallotsKey = (sessionId: string) => [...nightKey(sessionId), "ballots"] as const;

/** Ballots that actually hold picks: the "has this person voted" fact (as `VotingFlow` reads it). */
export function castBallots(ballots: readonly OwnBallot[] | undefined): OwnBallot[] {
  return (ballots ?? []).filter((b) => b.ranks.length > 0);
}

type Movie = { title: string; posterPath: string | null };

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The winner from the stored result (ADR-0006), as the night screens show it. */
function winnerOf(night: Night | undefined, summary?: Pick<NightSummary, "winner">): Movie | null {
  const option = night?.result
    ? night.options.find((o) => o.id === night.result?.winner_option_id)
    : undefined;
  const winner = option ?? summary?.winner ?? null;
  return winner ? { title: winner.title, posterPath: winner.poster_path } : null;
}

const EYEBROW: Record<TonightState, string> = {
  T0: "Tonight",
  T1: "Starting",
  T2: "Voting open",
  T3: "Voting open",
  T4: "Voting open",
  T5: "Winner in",
  T6: "Tonight",
  T7: "Last night",
};

/**
 * Home's Tonight card (guest-home §5 H1), from plain props so every state is unit-tested without a
 * router or a server. Exactly one `primary-action`, except T0 and T4, which are `waiting` states.
 */
export function TonightCardView({
  state,
  primary,
  isNew = false,
  shortlisted = 0,
  votes,
  waitingNames = [],
  movie,
  changeHref,
  rateHref,
  here,
  onOpen,
  onSwitch,
  onNotNow,
}: {
  state: TonightState;
  primary: TonightPrimary | null;
  isNew?: boolean;
  /** T1: titles on the shortlist so far. */
  shortlisted?: number;
  /** T2/T4: "N of M voted". */
  votes?: { voted: number; total: number };
  /** T3: the others on this phone still to vote. */
  waitingNames?: string[];
  /** T5/T6/T7: the winner (or the night to rate). */
  movie?: Movie | null;
  /** T4: Change my picks. */
  changeHref?: string;
  /** T6: Already watched? Rate it. */
  rateHref?: string;
  /** T2–T4: the Here tonight row. */
  here?: React.ReactNode;
  /** A primary link was followed (records the night as seen). */
  onOpen?: () => void;
  /** T3: Pass to next person. */
  onSwitch?: () => void;
  /** T7: Not now. */
  onNotNow?: () => void;
}) {
  const live = state !== "T0" && state !== "T7";
  const waiting = state === "T0" || state === "T4";
  const showNew = isNew && (state === "T1" || state === "T2");
  const title = movie?.title ?? "movie night";
  const voteLine = votes ? (
    <strong className="text-foreground">
      {votes.voted} of {votes.total}
    </strong>
  ) : null;

  let body: React.ReactNode;
  switch (state) {
    case "T0":
      body = (
        <MediaRow art={<Clap />}>
          <Heading>{HOME_COPY.t0.title}</Heading>
          <Sub live>{HOME_COPY.t0.body}</Sub>
        </MediaRow>
      );
      break;
    case "T1":
      body = (
        <MediaRow art={<Clap />}>
          <Heading>{HOME_COPY.t1.title}</Heading>
          <Sub>{HOME_COPY.t1.body(shortlisted)}</Sub>
        </MediaRow>
      );
      break;
    case "T2":
      body = (
        <>
          <Heading big>{HOME_COPY.t2.title}</Heading>
          <Sub>{voteLine} voted. Pick your favourites.</Sub>
          {here}
        </>
      );
      break;
    case "T3":
      body = (
        <>
          <Heading big>{HOME_COPY.t3.title}</Heading>
          <Sub>
            <strong className="text-foreground">{listNames(waitingNames)}</strong> on this phone
            still need to vote.
          </Sub>
          {here}
        </>
      );
      break;
    case "T4":
      body = (
        <>
          <Heading big>{HOME_COPY.t4.title}</Heading>
          <Sub live>{voteLine} voted. The winner shows up here.</Sub>
          {here}
        </>
      );
      break;
    case "T5":
      body = (
        <>
          <Sub>{HOME_COPY.t5.title}</Sub>
          <MediaRow
            art={
              <Poster
                title={title}
                posterPath={movie?.posterPath ?? null}
                className="w-18 shrink-0"
              />
            }
          >
            <Heading>{title}</Heading>
          </MediaRow>
        </>
      );
      break;
    case "T6":
      body = (
        <>
          <MediaRow
            art={
              <Poster
                title={title}
                posterPath={movie?.posterPath ?? null}
                className="w-18 shrink-0"
              />
            }
          >
            <Heading>
              Tonight: <strong>{title}</strong>
            </Heading>
          </MediaRow>
          <Sub>{HOME_COPY.t6.body}</Sub>
        </>
      );
      break;
    case "T7":
      body = (
        <MediaRow
          art={
            <Poster
              title={title}
              posterPath={movie?.posterPath ?? null}
              className="w-18 shrink-0"
            />
          }
        >
          <Heading>
            How was <strong>{title}</strong>?
          </Heading>
        </MediaRow>
      );
      break;
  }

  return (
    <section
      aria-label="Tonight"
      data-testid="tonight-card"
      data-state={state}
      className={cn(
        "flex flex-col gap-4 rounded-2xl bg-card p-5 ring-1",
        waiting
          ? "ring-foreground/10"
          : "bg-[linear-gradient(180deg,var(--accent-cinema-muted),transparent_60%)] ring-cinema/35",
      )}
    >
      <div className="flex items-center gap-2 text-xs tracking-[0.08em] text-muted-foreground uppercase">
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-cinema">
            <span
              aria-hidden
              className="size-2 animate-pulse rounded-full bg-cinema motion-reduce:animate-none"
            />
            {EYEBROW[state]}
          </span>
        ) : (
          EYEBROW[state]
        )}
        {showNew ? (
          <span
            data-testid="just-started"
            className="inline-flex h-6 items-center rounded-full bg-cinema px-2.5 text-xs font-semibold tracking-normal text-cinema-foreground normal-case"
          >
            {HOME_COPY.new}
          </span>
        ) : null}
      </div>
      <span aria-live="polite" className="sr-only" data-testid="tonight-announce">
        {showNew ? HOME_COPY.newAnnounce : ""}
      </span>
      {waiting ? (
        <div data-testid="waiting" className="flex flex-col gap-3">
          {body}
        </div>
      ) : (
        body
      )}
      {primary ? (
        "href" in primary ? (
          <Link
            href={primary.href}
            onClick={onOpen}
            data-testid="primary-action"
            className={cn(buttonVariants({ size: "tap" }), "w-full")}
          >
            {primary.label}
          </Link>
        ) : (
          <Button size="tap" className="w-full" data-testid="primary-action" onClick={onSwitch}>
            {primary.label}
          </Button>
        )
      ) : null}
      {state === "T4" && changeHref ? (
        <Link
          href={changeHref}
          data-testid="change-picks"
          className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
        >
          {HOME_COPY.t4.change}
        </Link>
      ) : null}
      {state === "T6" && rateHref ? (
        <Link
          href={rateHref}
          data-testid="tonight-rate"
          className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
        >
          {HOME_COPY.t6.rate}
        </Link>
      ) : null}
      {state === "T7" && onNotNow ? (
        <Button
          variant="ghost"
          size="tap"
          className="w-full text-muted-foreground"
          onClick={onNotNow}
        >
          Not now
        </Button>
      ) : null}
    </section>
  );
}

function Clap() {
  return (
    <span className="grid aspect-[2/3] w-18 shrink-0 place-items-center rounded-xl bg-muted">
      <Clapperboard aria-hidden className="size-7 text-cinema" />
    </span>
  );
}

function MediaRow({ art, children }: { art: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      {art}
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Heading({ big = false, children }: { big?: boolean; children: React.ReactNode }) {
  return (
    <h2 className={cn("font-heading leading-tight font-semibold", big ? "text-2xl" : "text-xl")}>
      {children}
    </h2>
  );
}

function Sub({ live = false, children }: { live?: boolean; children: React.ReactNode }) {
  return (
    <p aria-live={live ? "polite" : undefined} className="text-lg text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The Tonight card wired to the household (§5 H1, §6): T0/T7 without a live night, else the live
 * night followed over its stream. It updates in place and never navigates by itself (§3.3 rule 4).
 */
export function Tonight({
  night,
  isNew,
  people,
  current,
  ratePrompt,
}: {
  night?: NightSummary;
  isNew: boolean;
  people: PersonTile[];
  current: PersonTile;
  ratePrompt: RatePrompt | null;
}) {
  if (night) {
    return (
      <LiveTonight
        key={night.id}
        summary={night}
        isNew={isNew}
        people={people}
        current={current}
        ratePrompt={ratePrompt}
      />
    );
  }
  const { state, primary } = tonightState({
    people,
    rateOwed: ratePrompt ? { sessionId: ratePrompt.night.id } : null,
  });
  return (
    <TonightCardView
      state={state}
      primary={primary}
      movie={ratePrompt ? winnerOf(undefined, ratePrompt.night) : null}
      onNotNow={ratePrompt?.dismiss}
    />
  );
}

function LiveTonight({
  summary,
  isNew,
  people,
  current,
  ratePrompt,
}: {
  summary: NightSummary;
  isNew: boolean;
  people: PersonTile[];
  current: PersonTile;
  ratePrompt: RatePrompt | null;
}) {
  const queryClient = useQueryClient();
  const session = useLiveSession(summary.id);
  const status = session.data?.status ?? summary.status;
  const voting = status === "voting";
  const ballots = useQuery<OwnBallot[], ApiError>({
    queryKey: homeBallotsKey(summary.id),
    queryFn: () => api.myBallots(summary.id),
    enabled: voting,
  });
  const voters = useVoters(summary.id, voting, session.live);
  const [switching, setSwitching] = useState(false);

  // A status change moves the rating that's owed and the recent nights along (T6 → T7 on close).
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: latestWatchedNightQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: profileKey(current.id) });
  }, [queryClient, status, current.id]);

  const cast = castBallots(ballots.data);
  const votedIds = new Set(cast.map((b) => b.person_id));
  const closedOwed = status === "closed" ? ratePrompt : null;
  const { state, primary } = tonightState({
    night: { id: summary.id, status },
    myBallots: cast,
    people,
    rateOwed: closedOwed ? { sessionId: closedOwed.night.id } : null,
  });
  const here =
    session.data && (state === "T2" || state === "T3" || state === "T4") ? (
      <HereTonight
        night={session.data}
        live={session.live}
        people={people}
        selfId={current.id}
        compact
      />
    ) : null;

  return (
    <div data-live={session.live} className="contents">
      <TonightCardView
        state={state}
        primary={primary}
        isNew={isNew}
        shortlisted={session.data?.options.length ?? 0}
        votes={{ voted: voters.data?.length ?? votedIds.size, total: people.length }}
        waitingNames={stillToVote(people, votedIds, current.id).map((p) => p.name)}
        movie={
          state === "T7" && closedOwed
            ? winnerOf(undefined, closedOwed.night)
            : winnerOf(session.data, summary)
        }
        changeHref={nightHref(summary.id)}
        rateHref={`${nightHref(summary.id)}#rate`}
        here={here}
        onOpen={() => markNightSeen(summary.id)}
        onSwitch={() => setSwitching(true)}
        onNotNow={closedOwed?.dismiss}
      />
      {switching ? (
        <SwitchSheet
          people={people}
          current={current}
          votedIds={votedIds}
          onClose={() => setSwitching(false)}
        />
      ) : null}
    </div>
  );
}
