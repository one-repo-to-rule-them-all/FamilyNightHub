"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Tv } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api,
  type Account,
  type ApiError,
  type Claim,
  enrollDevice,
  type NightSummary,
} from "@/lib/api";
import { rememberNightCode } from "@/lib/night-code-handoff";

import { NightCodeCard } from "./night-code-card";
import { STATUS_LABEL } from "./status";

const ACTIVE = ["draft", "voting", "revealed", "tonight"] as const;
const CLAIMS_POLL_MS = 10_000;

type Created = { session_id: string; night_code: string };

export function HostHome() {
  const router = useRouter();
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation<void, ApiError>({
    mutationFn: api.logout,
    onSuccess: () => router.replace("/login"),
  });
  const [created, setCreated] = useState<Created | null>(null);
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (me.isPending || signedOut) {
    return <p className="text-lg text-muted-foreground">Loading…</p>;
  }
  if (me.isError) return <ApiErrorNotice error={me.error} />;

  return (
    <div className="flex flex-col gap-8">
      <p className="text-lg" data-testid="signed-in-as">
        Signed in as <strong>{me.data.display_name}</strong> ({me.data.role}) for{" "}
        {me.data.household_name}.
      </p>

      {created ? (
        <div className="flex flex-col gap-3">
          <NightCodeCard
            sessionId={created.session_id}
            status="draft"
            initialCode={created.night_code}
          />
          <Link
            href={`/host/${created.session_id}`}
            className="flex h-14 items-center justify-center rounded-xl bg-primary px-6 text-lg font-medium text-primary-foreground outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Build the shortlist
          </Link>
        </div>
      ) : (
        <StartNight onCreated={setCreated} />
      )}

      <ActiveNights />
      <PendingClaims />
      <UseAsTv sessionId={created?.session_id ?? null} />

      <ApiErrorNotice error={logout.error} />
      <Button
        variant="outline"
        size="tap"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        Sign out
      </Button>
    </div>
  );
}

function StartNight({ onCreated }: { onCreated: (created: Created) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const create = useMutation<Created, ApiError, string>({
    mutationFn: (value) => api.createNight({ title: value.trim() || null }),
    onSuccess: (result) => {
      rememberNightCode(result.session_id, result.night_code);
      void queryClient.invalidateQueries({ queryKey: ["nights"] });
      onCreated(result);
    },
  });

  return (
    <form
      aria-labelledby="start-night"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!create.isPending) create.mutate(title);
      }}
    >
      <h2 id="start-night" className="text-xl font-semibold">
        Start a night
      </h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="night-title" className="text-base">
          Name it (optional)
        </Label>
        <Input
          id="night-title"
          value={title}
          maxLength={120}
          placeholder="Friday movie night"
          onChange={(event) => setTitle(event.target.value)}
          className="h-14 text-lg md:text-lg"
        />
      </div>
      <ApiErrorNotice error={create.error} />
      <Button type="submit" size="tap" disabled={create.isPending}>
        {create.isPending ? "Starting…" : "Start a night"}
      </Button>
    </form>
  );
}

function ActiveNights() {
  const nights = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "active"],
    queryFn: () => api.nights({ status: [...ACTIVE] }),
  });

  return (
    <section aria-labelledby="active-nights" className="flex flex-col gap-3">
      <h2 id="active-nights" className="text-xl font-semibold">
        Nights in progress
      </h2>
      <ApiErrorNotice error={nights.error} />
      {nights.isPending ? <p className="text-muted-foreground">Loading…</p> : null}
      {nights.data?.length === 0 ? (
        <p className="text-muted-foreground">Nothing yet. Start a night above.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {nights.data?.map((night) => (
          <li key={night.id}>
            <Link
              href={`/host/${night.id}`}
              className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex flex-col">
                <span className="text-lg font-medium">{night.title || "Movie night"}</span>
                <span className="text-sm text-muted-foreground">
                  {STATUS_LABEL[night.status]} · started{" "}
                  {new Date(night.created_at).toLocaleString([], {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </span>
              <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PendingClaims() {
  const queryClient = useQueryClient();
  const claims = useQuery<Claim[], ApiError>({
    queryKey: ["claims"],
    queryFn: api.claims,
    refetchInterval: CLAIMS_POLL_MS,
  });
  const decide = useMutation<void, ApiError, { claim: Claim; approve: boolean }>({
    mutationFn: ({ claim, approve }) =>
      approve
        ? api.approveClaim(claim.device_id, claim.person_id)
        : api.rejectClaim(claim.device_id, claim.person_id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["claims"] }),
  });

  return (
    <section aria-labelledby="claims" className="flex flex-col gap-3">
      <h2 id="claims" className="text-xl font-semibold">
        Waiting for approval
      </h2>
      <ApiErrorNotice error={claims.error ?? decide.error} />
      {claims.data?.length === 0 ? (
        <p className="text-muted-foreground">No phones are waiting.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {claims.data?.map((claim) => {
          const busy =
            decide.isPending &&
            decide.variables?.claim.device_id === claim.device_id &&
            decide.variables.claim.person_id === claim.person_id;
          return (
            <li
              key={`${claim.device_id}:${claim.person_id}`}
              data-testid="claim"
              className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
            >
              <p className="flex items-center gap-3 text-base">
                <Avatar emoji={claim.avatar_emoji} color="#888888" className="size-10 text-2xl" />
                <span>
                  <strong>{claim.device_label || "A phone"}</strong> wants to be{" "}
                  <strong>{claim.person_name}</strong>.
                </span>
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  size="tap"
                  disabled={busy}
                  aria-label={`Approve ${claim.person_name}`}
                  onClick={() => decide.mutate({ claim, approve: true })}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  size="tap"
                  disabled={busy}
                  aria-label={`Reject ${claim.person_name}`}
                  onClick={() => decide.mutate({ claim, approve: false })}
                >
                  Reject
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * ADR-0002 "Use as TV": mints a TV device for this browser and clears the host session here, so
 * a TV left in the living room never holds host rights. The night code just created stays in this
 * tab's sessionStorage, which is how it reaches the TV screen.
 */
function UseAsTv({ sessionId }: { sessionId: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const enroll = useMutation<unknown, ApiError>({
    mutationFn: () => enrollDevice({ as_tv: true, device_label: "Living-room TV" }),
    onSuccess: () => {
      queryClient.clear();
      router.replace(sessionId ? `/tv/${sessionId}` : "/tv");
    },
  });

  return (
    <section aria-labelledby="use-as-tv" className="flex flex-col gap-3">
      <h2 id="use-as-tv" className="flex items-center gap-2 text-xl font-semibold">
        <Tv aria-hidden className="size-5" /> The living-room TV
      </h2>
      <p className="text-muted-foreground">
        Open this page on the TV&apos;s browser, start the night there, then turn it into the TV.
        This signs you out on this browser.
      </p>
      <ApiErrorNotice error={enroll.error} />
      {confirming ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="tap"
            disabled={enroll.isPending}
            onClick={() => enroll.mutate()}
          >
            {enroll.isPending ? "Pairing…" : "Yes, make it the TV"}
          </Button>
          <Button variant="ghost" size="tap" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="tap" onClick={() => setConfirming(true)}>
          Use this browser as the TV
        </Button>
      )}
    </section>
  );
}
