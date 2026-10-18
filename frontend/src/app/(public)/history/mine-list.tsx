"use client";

import { useQuery } from "@tanstack/react-query";
import { Camera, Star, Trophy } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/poster";
import { buttonVariants } from "@/components/ui/button";
import { api, type ApiError, type Profile, type ProfileNight } from "@/lib/api";
import { HOME_COPY, nightHref } from "@/lib/home";
import { cn } from "@/lib/utils";

import { profileKey } from "../people/[id]/profile-view";
import { canRate, mineSummary, picksLine } from "./history";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * History *Mine* (guest-home §5 H2): the current person's nights from `GET /people/{me}/profile`,
 * newest first, each with their picks, 🏆 when their pick won, their stars or **Rate it**, and the
 * photo count (→ the album). The server only returns picks for nights past the reveal.
 */
export function MineList({ personId }: { personId: string }) {
  const profile = useQuery<Profile, ApiError>({
    queryKey: profileKey(personId),
    queryFn: () => api.profile(personId),
  });

  if (profile.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading your nights"
        className="flex flex-col gap-3"
      >
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }
  if (profile.isError) return <ApiErrorNotice error={profile.error} />;

  const { nights, stats } = profile.data;
  if (nights.length === 0) {
    return (
      <p className="text-lg text-muted-foreground" data-testid="history-empty">
        {HOME_COPY.empty.mine}
      </p>
    );
  }
  return (
    <>
      <p className="text-muted-foreground" data-testid="history-summary">
        {mineSummary(stats).map((part, i) => (
          <span key={part.label}>
            {i > 0 ? " · " : null}
            {part.prefix ? `${part.prefix} ` : null}
            <b className="font-semibold text-foreground">{part.value}</b> {part.label}
          </span>
        ))}
      </p>
      <ul className="flex flex-col gap-3" data-testid="history-list">
        {nights.map((night) => (
          <MineRow key={night.session_id} night={night} />
        ))}
      </ul>
    </>
  );
}

function MineRow({ night }: { night: ProfileNight }) {
  const when = new Date(night.date);
  const title = night.winner?.title ?? night.title ?? "Movie night";
  const picks = picksLine(night);
  const rate = canRate(night);
  return (
    <li
      className="flex flex-col gap-3 rounded-2xl bg-card p-3 ring-1 ring-foreground/10"
      data-testid="history-row"
    >
      <Link
        href={nightHref(night.session_id)}
        className="flex items-center gap-4 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        <Poster
          title={title}
          posterPath={night.winner?.poster_path ?? null}
          className="w-20 shrink-0"
        />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-lg leading-tight font-medium" data-testid="history-winner">
            {title}
          </span>
          <time dateTime={when.toISOString()} className="text-muted-foreground">
            {dateFormat.format(when)}
          </time>
          {picks ? (
            <span className="text-sm text-muted-foreground" data-testid="history-picks">
              {picks}
            </span>
          ) : null}
          {night.picked_winner ? (
            <span className="flex items-center gap-1 text-sm text-cinema" data-testid="history-won">
              <Trophy aria-hidden className="size-4" />
              {HOME_COPY.badge.won}
            </span>
          ) : null}
          {night.rating !== null ? (
            <span className="flex items-center gap-1 text-sm" data-testid="history-rated">
              <Star aria-hidden className="size-4 fill-current" />
              {HOME_COPY.badge.rated(night.rating)}
            </span>
          ) : null}
        </span>
      </Link>
      {rate || night.photo_count > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {rate ? (
            <Link
              href={`${nightHref(night.session_id)}#rate`}
              data-testid="history-rate"
              className={cn(buttonVariants({ variant: "secondary" }), "h-11 px-4 text-base")}
            >
              {HOME_COPY.badge.rate}
            </Link>
          ) : null}
          {night.photo_count > 0 ? (
            <Link
              href={`/albums/${encodeURIComponent(night.session_id)}`}
              data-testid="history-photos"
              className="flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <Camera aria-hidden className="size-4" />
              {night.photo_count} {night.photo_count === 1 ? "photo" : "photos"}
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
