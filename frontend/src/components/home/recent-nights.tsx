"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { profileKey } from "@/app/(public)/people/[id]/profile-view";
import { Poster } from "@/components/poster";
import { api, type ApiError, type Profile, type ProfileNight } from "@/lib/api";
import { HOME_COPY, nightHref } from "@/lib/home";

/** Home shows this many of the person's nights (§5 H1 item 4); the rest are on History → Mine. */
export const RECENT_NIGHTS = 3;

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Up to three facts per row: Your pick won, You rated ★n, or Rate it once ratings are open. */
export function nightBadges(
  night: Pick<ProfileNight, "picked_winner" | "rating" | "status">,
): string[] {
  const badges: string[] = [];
  if (night.picked_winner) badges.push(HOME_COPY.badge.won);
  if (night.rating !== null) badges.push(HOME_COPY.badge.rated(night.rating));
  else if (night.status === "tonight" || night.status === "closed")
    badges.push(HOME_COPY.badge.rate);
  return badges;
}

/** *My recent nights* (§5 H1 item 4), from plain props: the newest three, then See all my nights. */
export function RecentNightsList({ nights }: { nights: readonly ProfileNight[] }) {
  const recent = nights.slice(0, RECENT_NIGHTS);
  return (
    <section
      aria-labelledby="recent-heading"
      className="flex flex-col gap-3"
      data-testid="recent-nights"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="recent-heading" className="font-heading text-lg font-semibold">
          {HOME_COPY.recent.title}
        </h2>
        {recent.length > 0 ? (
          <Link
            href="/history?tab=mine"
            className="inline-flex min-h-12 items-center text-base underline underline-offset-4"
            data-testid="recent-all"
          >
            {HOME_COPY.recent.all}
          </Link>
        ) : null}
      </div>
      {recent.length === 0 ? (
        <p className="text-base text-muted-foreground" data-testid="recent-empty">
          {HOME_COPY.empty.mine}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {recent.map((night) => {
            const title = night.winner?.title ?? night.title ?? "Movie night";
            return (
              <li key={night.session_id}>
                <Link
                  href={nightHref(night.session_id)}
                  data-testid="recent-night"
                  className="flex min-h-14 items-center gap-3 rounded-xl bg-card p-2.5 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <Poster
                    title={title}
                    posterPath={night.winner?.poster_path ?? null}
                    className="w-12 shrink-0 rounded-lg"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate font-semibold">{title}</span>
                    <span className="text-sm text-muted-foreground">
                      {dateFormat.format(new Date(night.date))}
                    </span>
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                      {nightBadges(night).map((badge) => (
                        <span
                          key={badge}
                          className={badge === HOME_COPY.badge.rate ? "text-cinema" : undefined}
                        >
                          {badge === HOME_COPY.badge.won ? `🏆 ${badge}` : badge}
                        </span>
                      ))}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** *My recent nights* for the current person, from `GET /people/{me}/profile` (§6). */
export function RecentNights({ personId }: { personId: string }) {
  const profile = useQuery<Profile, ApiError>({
    queryKey: profileKey(personId),
    queryFn: () => api.profile(personId),
    refetchOnWindowFocus: true,
  });
  // A failed or loading profile just leaves the section out: the Tonight card is the action.
  if (!profile.data) return null;
  return <RecentNightsList nights={profile.data.nights} />;
}
