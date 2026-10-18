"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Star, Trophy } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { api, type ApiError, type Profile, type ProfileNight } from "@/lib/api";
import { profileStats } from "@/lib/profile";

import { memberSince } from "../../me/me";

export const profileKey = (personId: string) => ["people", personId, "profile"] as const;

/**
 * A person's history and stats (ADR-0014 "Profiles"): nights joined, picks, winners, ratings and
 * photos. Ballots appear only for nights past the reveal; the server enforces that. Content only:
 * `/people/[id]` renders it inside the guest shell (guest-home §5 H5), which owns the `<main>`.
 */
export function ProfileView({ personId }: { personId: string }) {
  const profile = useQuery<Profile, ApiError>({
    queryKey: profileKey(personId),
    queryFn: () => api.profile(personId),
  });

  if (profile.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading profile"
        className="h-40 animate-pulse rounded-2xl bg-muted"
      />
    );
  }
  if (profile.isError) {
    return <ApiErrorNotice error={profile.error} />;
  }

  const p = profile.data;
  return (
    <>
      <div className="flex items-center gap-4">
        <Avatar emoji={p.avatar_emoji} color={p.color} className="size-20 text-5xl" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">{p.name}</h1>
          <p className="text-muted-foreground">{memberSince(p)}</p>
        </div>
      </div>

      <section aria-labelledby="stats-title" className="flex flex-col gap-3">
        <h2 id="stats-title" className="text-xl font-medium">
          Stats
        </h2>
        <dl className="grid grid-cols-2 gap-3" data-testid="profile-stats">
          {profileStats(p.stats).map((stat) => (
            <div key={stat.label} className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
              <dt className="text-sm text-muted-foreground">{stat.label}</dt>
              <dd className="tabular text-2xl font-semibold">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="nights-title" className="flex flex-col gap-3">
        <h2 id="nights-title" className="text-xl font-medium">
          Movie nights
        </h2>
        {p.nights.length === 0 ? (
          <p className="text-muted-foreground">No movie nights yet.</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="profile-nights">
            {p.nights.map((night) => (
              <NightRow key={night.session_id} night={night} />
            ))}
          </ul>
        )}
      </section>

      {p.albums.length > 0 ? (
        <section aria-labelledby="albums-title" className="flex flex-col gap-3">
          <h2 id="albums-title" className="text-xl font-medium">
            Photos
          </h2>
          <ul className="flex flex-col gap-2">
            {p.albums.map((album) => (
              <li key={album.session_id}>
                <Link
                  href={`/albums/${album.session_id}`}
                  className="flex min-h-14 items-center justify-between rounded-xl bg-card px-4 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <span>{album.title ?? "Movie night"}</span>
                  <span className="text-muted-foreground">
                    {album.photo_count} {album.photo_count === 1 ? "photo" : "photos"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function NightRow({ night }: { night: ProfileNight }) {
  const date = new Date(night.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <li className="flex flex-col gap-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium">{night.winner?.title ?? night.title ?? "Movie night"}</p>
        <p className="text-sm text-muted-foreground">{date}</p>
      </div>
      {night.picks.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Picked:{" "}
          {[...night.picks]
            .sort((a, b) => a.rank - b.rank)
            .map((pick) => pick.movie.title)
            .join(", ")}
        </p>
      ) : null}
      <p className="flex flex-wrap gap-3 text-sm">
        {night.picked_winner ? (
          <span className="flex items-center gap-1 text-cinema">
            <Trophy aria-hidden className="size-4" />
            Picked the winner
          </span>
        ) : null}
        {night.rating !== null ? (
          <span className="flex items-center gap-1">
            <Star aria-hidden className="size-4" />
            Rated {night.rating} of 5
          </span>
        ) : null}
        {night.photo_count > 0 ? (
          <span className="flex items-center gap-1">
            <Check aria-hidden className="size-4" />
            {night.photo_count} {night.photo_count === 1 ? "photo" : "photos"}
          </span>
        ) : null}
      </p>
    </li>
  );
}
