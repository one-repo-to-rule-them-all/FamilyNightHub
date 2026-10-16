"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hourglass, Smartphone } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { RatePromptCard } from "@/components/night/rate-prompt-card";
import { buttonVariants } from "@/components/ui/button";
import { api, type ApiError, type Binding, type NightSummary, type Person } from "@/lib/api";
import { cn } from "@/lib/utils";

const PEOPLE = ["people"] as const;

const LIVE_LINK: Partial<Record<NightSummary["status"], string>> = {
  voting: "Vote now",
  revealed: "See tonight's movie",
  tonight: "See tonight's movie",
};

const STATE_LABEL: Record<Person["binding"], string | null> = {
  mine: "That's you",
  pending: "Pending — ask the host",
  taken: "On another phone",
  free: null,
};

export function WhoGrid() {
  const queryClient = useQueryClient();
  const people = useQuery<Person[], ApiError>({ queryKey: PEOPLE, queryFn: api.people });
  const claim = useMutation<Binding, ApiError, string>({
    mutationFn: api.claimPerson,
    onSettled: () => queryClient.invalidateQueries({ queryKey: PEOPLE }),
  });
  // The household's current night, if any, so a picked phone can go straight to it.
  const live = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "live"],
    queryFn: () => api.nights({ status: ["voting", "revealed", "tonight"], limit: 1 }),
  });

  if (people.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading people"
        className="grid grid-cols-2 gap-3"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }

  if (people.isError) {
    if (people.error.status === 401) {
      return (
        <div role="alert" className="flex flex-col gap-2 rounded-xl bg-card p-5 text-lg">
          <p>This phone hasn&apos;t joined tonight yet.</p>
          <p className="text-muted-foreground">
            Scan the QR code on the TV, then enter the night code.
          </p>
        </div>
      );
    }
    return <ApiErrorNotice error={people.error} />;
  }

  const mine = people.data.filter((p) => p.binding === "mine");
  const pending = people.data.filter((p) => p.binding === "pending");
  const current = live.data?.[0];
  const currentLabel = current ? LIVE_LINK[current.status] : undefined;

  return (
    <div className="flex flex-col gap-5">
      <RatePromptCard />
      <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
        {mine.length > 0 ? (
          <p className="rounded-xl bg-cinema-muted p-4 text-base" data-testid="who-status">
            You&apos;re in as <strong>{mine.map((p) => p.name).join(" & ")}</strong>. Voting opens
            on the TV.
          </p>
        ) : null}
        {pending.length > 0 ? (
          <p className="rounded-xl bg-card p-4 text-base ring-1 ring-foreground/10">
            Waiting for the host to approve this phone for{" "}
            <strong>{pending.map((p) => p.name).join(" & ")}</strong>. Ask the host to approve it.
          </p>
        ) : null}
      </div>

      {mine.length > 0 && current && currentLabel ? (
        <Link
          href={`/s/${current.id}`}
          className={cn(buttonVariants({ size: "tap" }), "w-full")}
          data-testid="go-to-night"
        >
          {currentLabel}
        </Link>
      ) : null}

      <ApiErrorNotice error={claim.error} />

      {people.data.length === 0 ? (
        <p className="text-lg text-muted-foreground">
          Nobody&apos;s been added yet. Ask the host to add your family.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {people.data.map((person) => (
            <li key={person.id}>
              <PersonTile
                person={person}
                busy={claim.isPending && claim.variables === person.id}
                onClaim={() => claim.mutate(person.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm text-muted-foreground">
        Hosting tonight?{" "}
        <Link href="/login" className="text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function PersonTile({
  person,
  busy,
  onClaim,
}: {
  person: Person;
  busy: boolean;
  onClaim: () => void;
}) {
  const label = STATE_LABEL[person.binding];
  const claimable = person.binding === "free" || person.binding === "taken";
  return (
    <button
      type="button"
      data-binding={person.binding}
      aria-disabled={!claimable || busy || undefined}
      aria-pressed={person.binding === "mine"}
      onClick={() => {
        if (claimable && !busy) onClaim();
      }}
      className={cn(
        "flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl bg-card p-3 text-center ring-1 ring-foreground/10 transition-transform outline-none focus-visible:ring-3 focus-visible:ring-ring active:scale-[0.98]",
        person.binding === "mine" && "marquee-glow",
        busy && "animate-pulse",
      )}
    >
      <span
        aria-hidden
        className="flex size-20 items-center justify-center rounded-full text-5xl"
        style={{ backgroundColor: `color-mix(in oklch, ${person.color} 45%, transparent)` }}
      >
        {person.avatar_emoji}
      </span>
      <span className="text-lg leading-tight font-medium">{person.name}</span>
      {label ? (
        <span
          className={cn(
            "flex items-center gap-1 text-sm",
            person.binding === "mine" ? "text-cinema" : "text-muted-foreground",
          )}
        >
          {person.binding === "mine" ? <Check aria-hidden className="size-4" /> : null}
          {person.binding === "pending" ? <Hourglass aria-hidden className="size-4" /> : null}
          {person.binding === "taken" ? <Smartphone aria-hidden className="size-4" /> : null}
          {label}
        </span>
      ) : null}
    </button>
  );
}
