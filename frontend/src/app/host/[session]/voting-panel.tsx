"use client";

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import type { LiveState } from "@/hooks/use-live-session";
import { useVoters, votersKey } from "@/hooks/use-voters";
import { api, type ApiError, enrollDevice, type Night, type Person } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toggleRank, toRanks } from "@/lib/shortlist";

/**
 * While voting: who has voted (avatars only; tallies stay hidden until reveal, ADR-0006), and a
 * proxy ballot for people without a phone.
 */
export function VotingPanel({ night, live }: { night: Night; live: LiveState }) {
  const voters = useVoters(night.id, true, live);
  // The household's people come from the device-scoped GET /people (the only people list a host
  // can read today), so the host's browser must also be an enrolled device to list them.
  const people = useQuery<Person[], ApiError>({ queryKey: ["people"], queryFn: api.people });
  const names = new Map(people.data?.map((p) => [p.id, p.name]));
  const voted = voters.data ?? [];

  return (
    <>
      <section aria-labelledby="who-voted" className="flex flex-col gap-3">
        <h2 id="who-voted" className="text-xl font-semibold">
          Who has voted{" "}
          <span className="text-base font-normal text-muted-foreground" data-testid="voted-count">
            {voted.length} so far
          </span>
        </h2>
        <ApiErrorNotice error={voters.error} />
        {voted.length === 0 ? <p className="text-muted-foreground">No votes yet.</p> : null}
        <ul className="flex flex-wrap gap-3" aria-label="Voted">
          {voted.map((v) => (
            <li
              key={v.person_id}
              data-testid="voter"
              className="flex flex-col items-center gap-1"
              aria-label={names.get(v.person_id) ?? "Someone"}
            >
              <Avatar emoji={v.avatar_emoji} color={v.color} className="size-14 text-3xl" />
              {names.has(v.person_id) ? (
                <span aria-hidden className="text-sm text-muted-foreground">
                  {names.get(v.person_id)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <ProxyBallot night={night} people={people} />
    </>
  );
}

function ProxyBallot({
  night,
  people,
}: {
  night: Night;
  people: UseQueryResult<Person[], ApiError>;
}) {
  const queryClient = useQueryClient();
  const [personId, setPersonId] = useState<string | null>(null);
  const [ranked, setRanked] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const k = night.ballot_size ?? 1;

  const enroll = useMutation<unknown, ApiError>({
    mutationFn: () => enrollDevice({ as_tv: false, device_label: "Host browser" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["people"] }),
  });
  const cast = useMutation<void, ApiError, { personId: string; ranked: string[] }>({
    mutationFn: (vars) =>
      api.proxyBallot(night.id, { person_id: vars.personId, ranks: toRanks(vars.ranked) }),
    onSuccess: (_, vars) => {
      setSaved(people.data?.find((p) => p.id === vars.personId)?.name ?? "Their");
      setPersonId(null);
      setRanked([]);
      void queryClient.invalidateQueries({ queryKey: votersKey(night.id) });
    },
  });
  const person = people.data?.find((p) => p.id === personId) ?? null;

  return (
    <section aria-labelledby="proxy-vote" className="flex flex-col gap-3">
      <h2 id="proxy-vote" className="text-xl font-semibold">
        Vote for someone
      </h2>
      <p className="text-muted-foreground">
        For kids without a phone: pick them, then {k === 1 ? "pick their movie" : `rank up to ${k}`}
        .
      </p>

      {people.error?.status === 401 ? (
        <div className="flex flex-col gap-2 rounded-xl bg-muted p-4">
          <p>
            To list your family here, this browser needs to be one of the household&apos;s devices.
          </p>
          <ApiErrorNotice error={enroll.error} />
          <Button
            variant="outline"
            size="tap"
            disabled={enroll.isPending}
            onClick={() => enroll.mutate()}
          >
            {enroll.isPending ? "Adding…" : "Add this browser as a device"}
          </Button>
        </div>
      ) : (
        <ApiErrorNotice error={people.error} />
      )}

      {saved ? (
        <p role="status" data-testid="proxy-saved" className="text-base">
          Saved {saved}&apos;s vote.
        </p>
      ) : null}

      {people.data ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="People">
          {people.data.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={p.id === personId}
                onClick={() => {
                  setSaved(null);
                  setRanked([]);
                  setPersonId(p.id === personId ? null : p.id);
                }}
                className={cn(
                  "flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl bg-card p-2 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  p.id === personId && "ring-2 ring-foreground",
                )}
              >
                <Avatar emoji={p.avatar_emoji} color={p.color} className="size-12 text-3xl" />
                <span className="text-base">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {person ? (
        <div className="flex flex-col gap-3">
          <p className="text-base">
            Ranking for <strong>{person.name}</strong>: tap in order of preference.
          </p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Rank titles">
            {night.options.map((option) => {
              const rank = ranked.indexOf(option.id) + 1;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    aria-pressed={rank > 0}
                    aria-label={rank > 0 ? `${option.title}, rank ${rank}` : option.title}
                    onClick={() => setRanked((r) => toggleRank(r, option.id, k))}
                    className="relative flex w-full flex-col gap-1 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring"
                  >
                    <Poster title={option.title} posterPath={option.poster_path} width="w185" />
                    <span className="line-clamp-2 text-sm leading-tight">{option.title}</span>
                    {rank > 0 ? (
                      <span
                        aria-hidden
                        className="absolute top-1 left-1 flex size-8 items-center justify-center rounded-full bg-foreground text-lg font-semibold text-background"
                      >
                        {rank}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <ApiErrorNotice error={cast.error} />
          <Button
            variant="secondary"
            size="tap"
            disabled={ranked.length === 0 || cast.isPending}
            onClick={() => cast.mutate({ personId: person.id, ranked })}
          >
            {cast.isPending ? "Saving…" : `Save ${person.name}'s vote`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
