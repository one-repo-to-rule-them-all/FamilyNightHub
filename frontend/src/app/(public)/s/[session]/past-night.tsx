"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Trophy } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { GuestShell } from "@/components/home/guest-shell";
import { Avatar } from "@/components/night/avatar";
import { myRatingsKey, RatingPanel } from "@/components/night/rating-panel";
import { PhotoAlbum } from "@/components/photos/photo-album";
import { buttonVariants } from "@/components/ui/button";
import { useHouseholdNight } from "@/hooks/use-household-night";
import { nightKey } from "@/hooks/use-live-session";
import { useLatestNight } from "@/hooks/use-phone";
import {
  api,
  type ApiError,
  type Night,
  type OwnBallot,
  type OwnRating,
  type PersonTile,
} from "@/lib/api";
import { hereTonight } from "@/lib/here-tonight";
import { HOME_COPY, pastNightKind } from "@/lib/home";
import type { LiveState } from "@/lib/live";
import { cn } from "@/lib/utils";

import { ScreenTitle } from "./screen-title";
import { Results, WinnerCard } from "./winner";

/** The same keys the ballot and Here tonight use, so the caches are shared. */
const ballotsKey = (sessionId: string) => ["ballots", sessionId] as const;
const presentKey = (sessionId: string) => [...nightKey(sessionId), "present"] as const;

const HISTORY_BACK = { href: "/history", label: HOME_COPY.hist.title };

/**
 * That's a wrap's one primary (guest-home §5 H3w): the live hand-off's **Go** when a newer night
 * is on (the shell renders it), else the star row while this person hasn't rated, else **Back to
 * Home**. `null` while the rating is still loading, so nothing is marked primary twice.
 */
export function wrapPrimary(input: {
  liveNight: boolean;
  rated: boolean | undefined;
}): "handoff" | "stars" | "home" | null {
  if (input.liveNight) return "handoff";
  if (input.rated === undefined) return null;
  return input.rated ? "home" : "stars";
}

/**
 * A closed night (guest-home §5 H3): That's a wrap for the household's latest night, the recap for
 * an older one (`pastNightKind`). Both sit in the shell with the 60 s auto-move on the hand-off
 * (H0c, owner decision §11.2); the countdown itself lives in `LiveHandoff`.
 *
 * The kind is settled once the latest night is known and then kept for this visit: when a new
 * night starts, the 30 s latest-night poll would otherwise turn That's a wrap into the recap under
 * the guest. One shell stays mounted either way, so the hand-off's countdown never restarts.
 */
export function PastNight(props: {
  night: Night;
  live: LiveState;
  people: PersonTile[];
  current: PersonTile;
}) {
  const latest = useLatestNight(true);
  const latestId = latest.data?.[0]?.id;
  const [settled, setSettled] = useState<"wrap" | "recap" | null>(null);
  if (settled === null && latest.data !== undefined) {
    setSettled(pastNightKind(props.night.id, latestId));
  }
  const kind = settled ?? pastNightKind(props.night.id, latestId);

  return (
    <GuestShell screen={kind} handoff="countdown" back={HISTORY_BACK}>
      {kind === "wrap" ? <ThatsAWrap {...props} /> : <NightRecap {...props} />}
    </GuestShell>
  );
}

function ThatsAWrap({
  night,
  live,
  current,
}: {
  night: Night;
  live: LiveState;
  current: PersonTile;
}) {
  const { night: liveNight } = useHouseholdNight(true);
  const ratings = useQuery<OwnRating[], ApiError>({
    queryKey: myRatingsKey(night.id),
    queryFn: () => api.myRatings(night.id),
  });
  const rated = ratings.data ? ratings.data.some((r) => r.person_id === current.id) : undefined;
  const primary = wrapPrimary({ liveNight: liveNight !== undefined, rated });

  return (
    <>
      <ScreenTitle title={HOME_COPY.wrap.title} lede={HOME_COPY.wrap.lede} />
      <WinnerCard night={night} compact />
      <div
        data-testid={primary === "stars" ? "primary-action" : undefined}
        data-primary={primary === "stars" || undefined}
      >
        <RatingPanel night={night} />
      </div>
      {primary === "home" ? (
        <Link
          href="/"
          data-testid="primary-action"
          className={cn(buttonVariants({ size: "tap" }), "w-full")}
        >
          {HOME_COPY.wrap.home}
        </Link>
      ) : null}
      <details className="group flex flex-col gap-3" data-testid="wrap-results">
        <summary
          className={cn(
            buttonVariants({ variant: "secondary", size: "tap" }),
            "w-full cursor-pointer list-none [&::-webkit-details-marker]:hidden",
          )}
        >
          See all results
        </summary>
        <div className="pt-3">
          <Results night={night} />
        </div>
      </details>
      {/* The rating or the hand-off is the primary here, so Add photos is `secondary`. */}
      <PhotoAlbum sessionId={night.id} live={live} actorId={current.id} primary={false} />
    </>
  );
}

function NightRecap({
  night,
  live,
  people,
  current,
}: {
  night: Night;
  live: LiveState;
  people: PersonTile[];
  current: PersonTile;
}) {
  const winnerId = night.result?.winner_option_id;
  const winner = night.options.find((o) => o.id === winnerId);
  const date = new Date(night.created_at).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <ScreenTitle title={night.title ?? winner?.title ?? "Movie night"} lede={date} />
      <WinnerCard night={night} compact />
      <YourNight night={night} current={current} />
      <section aria-labelledby="family-picks" className="flex flex-col gap-3">
        <h2 id="family-picks" className="text-xl font-medium">
          {HOME_COPY.recap.family}
        </h2>
        <Results night={night} />
      </section>
      <WhoCame night={night} people={people} />
      <PhotoAlbum sessionId={night.id} live={live} actorId={current.id} canAdd={false} />
      <Link
        href={`/albums/${night.id}`}
        data-testid="recap-photos"
        className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
      >
        {HOME_COPY.recap.photos}
      </Link>
    </>
  );
}

/** My picks with the winner marked, then my stars (editable: ratings stay open after closing). */
function YourNight({ night, current }: { night: Night; current: PersonTile }) {
  const ballots = useQuery<OwnBallot[], ApiError>({
    queryKey: ballotsKey(night.id),
    queryFn: () => api.myBallots(night.id),
  });
  const ranks = [...(ballots.data?.find((b) => b.person_id === current.id)?.ranks ?? [])].sort(
    (a, b) => a.rank - b.rank,
  );
  const titles = new Map(night.options.map((o) => [o.id, o.title]));
  const winnerId = night.result?.winner_option_id;
  const ranked = night.voting_method === "top3";

  return (
    <section aria-labelledby="your-night" className="flex flex-col gap-3" data-testid="your-night">
      <h2 id="your-night" className="text-xl font-medium">
        {HOME_COPY.recap.yours}
      </h2>
      {ballots.isSuccess ? (
        ranks.length > 0 ? (
          <ol className="flex flex-col gap-2" data-testid="recap-picks">
            {ranks.map((r) => {
              const won = r.option_id === winnerId;
              return (
                <li
                  key={r.option_id}
                  data-winner={won || undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-lg ring-1 ring-foreground/10",
                    won && "ring-cinema/60",
                  )}
                >
                  <span className="text-muted-foreground">
                    {ranked ? `${r.rank}.` : <Check aria-hidden className="size-5" />}
                  </span>
                  <span className="flex-1">{titles.get(r.option_id)}</span>
                  {won ? (
                    <span className="flex items-center gap-1 text-sm text-cinema">
                      <Trophy aria-hidden className="size-4" />
                      {HOME_COPY.badge.won}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-muted-foreground">You didn&apos;t vote this time.</p>
        )
      ) : null}
      <RatingPanel night={night} />
    </section>
  );
}

/** Who came (`GET /sessions/{id}/present`): avatars and names, never how anyone voted. */
function WhoCame({ night, people }: { night: Night; people: PersonTile[] }) {
  const present = useQuery({
    queryKey: presentKey(night.id),
    queryFn: async () => (await api.present(night.id)).present,
  });
  if (!present.isSuccess || present.data.length === 0) return null;
  const items = hereTonight(present.data, people);
  return (
    <section aria-labelledby="who-came" className="flex flex-col gap-3">
      <h2 id="who-came" className="text-xl font-medium">
        {HOME_COPY.recap.who}
      </h2>
      <ul className="flex flex-wrap gap-3" data-testid="who-came">
        {items.map((item) => (
          <li key={item.personId} className="flex w-14 flex-col items-center gap-1">
            <Avatar emoji={item.avatarEmoji} color={item.color} className="size-12 text-2xl" />
            <span className="w-full truncate text-center text-xs">{item.name ?? "Guest"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
