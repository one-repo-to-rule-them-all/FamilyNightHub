"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { votersKey } from "@/hooks/use-voters";
import { api, type ApiError, type Night, type NightSummary, type Voter } from "@/lib/api";
import { rememberNightCode } from "@/lib/night-code-handoff";
import { upNextState } from "@/lib/portal";
import { VOTING_METHODS } from "@/lib/voting-method";

import { NightCodeCard } from "@/app/host/night-code-card";

const primaryLink =
  "inline-flex h-12 items-center justify-center rounded-xl bg-primary px-5 text-base font-semibold text-primary-foreground outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 max-md:h-14 max-md:w-full max-md:text-lg";

type Created = { session_id: string; night_code: string };

/**
 * Up next (proposals/owner-portal.md §5 P1a): one state, one primary action. `current` is the
 * newest active night (or null); `lastNight` feeds the "Last one" line when nothing is running.
 */
export function UpNextCard({
  current,
  lastNight,
  onUseAsTv,
}: {
  current: NightSummary | null;
  lastNight: NightSummary | null;
  onUseAsTv?: (sessionId: string) => void;
}) {
  const [created, setCreated] = useState<Created | null>(null);
  const snapshot = useQuery<Night, ApiError>({
    queryKey: ["night", current?.id],
    queryFn: () => api.night(current!.id),
    enabled: !!current && current.status !== "closed",
  });
  const state = upNextState(current, {
    createdId: created?.session_id,
    optionCount: snapshot.data?.options.length ?? null,
  });
  // The code is shown once: as soon as that night moves past draft, the card forgets it
  // (adjusted while rendering, React's pattern for state derived from props).
  if (created && current?.id === created.session_id && current.status !== "draft") {
    setCreated(null);
  }

  const tvButton = (id: string) =>
    onUseAsTv ? (
      <Button variant="secondary" size="lg" className="px-3.5" onClick={() => onUseAsTv(id)}>
        Show it on this TV
      </Button>
    ) : null;

  return (
    <section
      data-testid="up-next"
      data-up-next={state.kind}
      aria-labelledby="up-next-title"
      className="flex flex-col gap-4 rounded-2xl bg-card p-5 ring-1 ring-foreground/10"
    >
      {state.kind === "none" && !created ? (
        <StartNight lastNight={lastNight} onCreated={setCreated} />
      ) : created && (state.kind === "created" || state.kind === "none") ? (
        <>
          <Eyebrow>Up next</Eyebrow>
          <h2 id="up-next-title" className="text-xl font-semibold">
            Movie night is on. Here&apos;s the code.
          </h2>
          <NightCodeCard
            sessionId={created.session_id}
            status="draft"
            initialCode={created.night_code}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/host/${created.session_id}`}
              className={primaryLink}
              data-testid="primary-action"
            >
              Build the shortlist
            </Link>
            {tvButton(created.session_id)}
          </div>
        </>
      ) : state.kind === "draft" || state.kind === "created" ? (
        <>
          <Eyebrow>Up next · building</Eyebrow>
          <h2 id="up-next-title" className="text-xl font-semibold">
            {current?.title || "Tonight's shortlist"}
          </h2>
          <p className="text-muted-foreground">
            {snapshot.data
              ? state.kind === "draft" && state.ready
                ? `${snapshot.data.options.length} titles · ${VOTING_METHODS.find((m) => m.value === snapshot.data.voting_method)?.label ?? ""} voting`
                : "Add at least 2 titles before voting."
              : "Loading the shortlist…"}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/host/${state.nightId}`}
              className={primaryLink}
              data-testid="primary-action"
            >
              {state.kind === "draft" && state.ready ? "Open voting" : "Finish the shortlist"}
            </Link>
            {tvButton(state.nightId)}
          </div>
        </>
      ) : state.kind === "voting" ? (
        <Voting nightId={state.nightId} title={current?.title ?? null} />
      ) : (
        <Tonight night={current!} />
      )}
    </section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{children}</p>
  );
}

function StartNight({
  lastNight,
  onCreated,
}: {
  lastNight: NightSummary | null;
  onCreated: (created: Created) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const create = useMutation<Created, ApiError, string>({
    mutationFn: (value) => api.createNight({ title: value.trim() || null }),
    onSuccess: (result) => {
      rememberNightCode(result.session_id, result.night_code);
      onCreated(result);
      void queryClient.invalidateQueries({ queryKey: ["nights"] });
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!create.isPending) create.mutate(title);
      }}
    >
      <Eyebrow>Up next</Eyebrow>
      <div className="flex flex-col gap-1">
        <h2 id="up-next-title" className="text-xl font-semibold">
          No movie night yet
        </h2>
        <p className="text-muted-foreground">
          {lastNight ? (
            <>
              Last one:{" "}
              <strong className="text-foreground">
                {lastNight.winner?.title ?? lastNight.title ?? "Movie night"}
              </strong>{" "}
              on {new Date(lastNight.created_at).toLocaleDateString([], { weekday: "long" })}
            </>
          ) : (
            "Start the family's first one."
          )}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="night-title">Name it (optional)</Label>
        <Input
          id="night-title"
          value={title}
          maxLength={120}
          placeholder="Friday movie night"
          onChange={(event) => setTitle(event.target.value)}
          className="h-11 md:max-w-sm"
        />
      </div>
      <ApiErrorNotice error={create.error} />
      <Button
        type="submit"
        size="tap"
        data-testid="primary-action"
        className="self-start max-md:w-full md:h-12 md:text-base"
        disabled={create.isPending}
      >
        {create.isPending ? "Starting…" : "Start movie night"}
      </Button>
    </form>
  );
}

function Voting({ nightId, title }: { nightId: string; title: string | null }) {
  // Home doesn't hold the night's live stream, so it polls at the claims cadence.
  const voters = useQuery<Voter[], ApiError>({
    queryKey: votersKey(nightId),
    queryFn: async () => (await api.voters(nightId)).voted,
    refetchInterval: 10_000,
  });
  const list = voters.data ?? [];
  return (
    <>
      <Eyebrow>Up next · voting</Eyebrow>
      <h2 id="up-next-title" className="text-xl font-semibold">
        {title ? `${title}: voting is open` : "Voting is open"}
      </h2>
      <p className="text-muted-foreground" aria-live="polite">
        {voters.data ? (
          <>
            <strong className="text-foreground">{list.length}</strong>{" "}
            {list.length === 1 ? "person has" : "people have"} voted
          </>
        ) : (
          "Counting votes…"
        )}
      </p>
      {list.length > 0 ? (
        <div className="flex -space-x-1.5" aria-hidden>
          {list.slice(0, 10).map((v) => (
            <Avatar
              key={v.person_id}
              emoji={v.avatar_emoji}
              color={v.color}
              className="size-7 text-sm ring-2 ring-card"
            />
          ))}
        </div>
      ) : null}
      <Link
        href={`/host/${nightId}`}
        className={`${primaryLink} self-start`}
        data-testid="primary-action"
      >
        See votes
      </Link>
    </>
  );
}

function Tonight({ night }: { night: NightSummary }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const close = useMutation<Night, ApiError>({
    mutationFn: () => api.closeNight(night.id),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["nights"] });
    },
  });
  const winner = night.winner;

  return (
    <div className="flex gap-4">
      {winner ? (
        <Poster
          posterPath={winner.poster_path}
          title={winner.title}
          width="w185"
          className="w-20 shrink-0"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Eyebrow>Up next · watching tonight</Eyebrow>
        <h2 id="up-next-title" className="text-xl font-semibold">
          {winner?.title ?? night.title ?? "Tonight's movie"}
        </h2>
        <p className="text-muted-foreground">
          Picked by <strong className="text-foreground">{night.turnout}</strong> · photos are open
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="tap"
            data-testid="primary-action"
            className="max-md:w-full md:h-12 md:text-base"
            onClick={() => {
              close.reset();
              setConfirming(true);
            }}
          >
            End the night
          </Button>
          <Link
            href={`/host/${night.id}`}
            className="rounded-md text-sm underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Open the night
          </Link>
        </div>
      </div>
      {confirming ? (
        <ModalDialog
          title="End the night?"
          onClose={() => setConfirming(false)}
          testId="end-night-confirm"
        >
          <p className="text-sm">
            Phones stop joining with tonight&apos;s code. Photos and ratings stay open.
          </p>
          <ApiErrorNotice error={close.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              className="px-4"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              {close.isPending ? "Ending…" : "End the night"}
            </Button>
            <Button variant="ghost" size="lg" className="px-4" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}
