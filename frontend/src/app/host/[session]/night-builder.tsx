"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Images, Square, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { type LiveState, nightKey, useLiveSession } from "@/hooks/use-live-session";
import { api, type ApiError, type Night } from "@/lib/api";
import { forgetNightCode } from "@/lib/night-code-handoff";
import { canOpenVoting, MAX_OPTIONS, MIN_OPTIONS } from "@/lib/shortlist";
import { hostAction, hostStatus } from "@/lib/slideshow-control";

import { NightCodeCard } from "../night-code-card";
import { STATUS_LABEL } from "../status";
import { CandidateRoller } from "./candidate-roller";
import { MovieSearch } from "./movie-search";
import { NightRatings } from "./night-ratings";
import { ShortlistEditor } from "./shortlist-editor";
import { VotingMethodPicker } from "./voting-method-picker";
import { VotingPanel } from "./voting-panel";

/**
 * P6 Run a night (owner-portal.md): shortlist → open voting → who has voted / proxy votes →
 * close → winner → end the night; once ratings open, who has rated. One primary per stage
 * (`data-testid="primary-action"`): Open voting, Close voting, End the night.
 */
export function NightBuilder({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const night = useLiveSession(sessionId);
  const { live } = night;
  const signedOut = night.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (night.isPending || signedOut) {
    return (
      <NightScreen>
        <p className="text-lg text-muted-foreground">Loading…</p>
      </NightScreen>
    );
  }
  if (!night.data) {
    return (
      <NightScreen>
        <ApiErrorNotice error={night.error} />
      </NightScreen>
    );
  }

  const data = night.data;
  const ratingsOpen = data.status === "tonight" || data.status === "closed";
  return (
    <NightScreen live={live} status={data.status}>
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {data.title || "Movie night"}
        </h1>
        <p className="text-muted-foreground" data-testid="night-status">
          {STATUS_LABEL[data.status]}
        </p>
      </header>

      {data.status === "draft" ? <DraftStage night={data} /> : null}
      {data.status === "voting" ? <VotingStage night={data} live={live} /> : null}
      {data.result ? <WinnerStage night={data} /> : null}
      {data.status === "tonight" || data.status === "closed" ? (
        <SlideshowControl night={data} />
      ) : null}
      {ratingsOpen && data.result ? <NightRatings night={data} live={live} /> : null}

      {data.status !== "closed" ? <NightCodeCard sessionId={data.id} status={data.status} /> : null}
    </NightScreen>
  );
}

/** The screen root, with the "← Home" back link above every state (loading and errors too). */
function NightScreen({
  live,
  status,
  children,
}: {
  live?: LiveState;
  status?: Night["status"];
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-8"
      data-screen="portal-night"
      data-live={live}
      data-status={status}
    >
      <Link
        href="/host"
        className="-mb-6 flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeft aria-hidden className="size-4" /> Home
      </Link>
      {children}
    </div>
  );
}

function useNightMutation<TVars>(sessionId: string, fn: (vars: TVars) => Promise<Night>) {
  const queryClient = useQueryClient();
  return useMutation<Night, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: (next) => queryClient.setQueryData(nightKey(sessionId), next),
  });
}

function DraftStage({ night }: { night: Night }) {
  const open = useNightMutation<void>(night.id, () => api.openVoting(night.id));
  const count = night.options.length;

  return (
    <>
      <ShortlistEditor night={night} />
      <CandidateRoller night={night} />
      <MovieSearch night={night} />
      <VotingMethodPicker night={night} />
      <div className="flex flex-col gap-2">
        <ApiErrorNotice error={open.error} />
        <Button
          size="tap"
          data-testid="primary-action"
          disabled={!canOpenVoting(count) || open.isPending}
          onClick={() => open.mutate()}
        >
          {open.isPending ? "Opening…" : "Open voting"}
        </Button>
        {!canOpenVoting(count) ? (
          <p className="text-sm text-muted-foreground">
            Voting needs {MIN_OPTIONS} to {MAX_OPTIONS} titles.
          </p>
        ) : null}
      </div>
    </>
  );
}

function VotingStage({ night, live }: { night: Night; live: LiveState }) {
  const close = useNightMutation<void>(night.id, () => api.closeVoting(night.id));
  return (
    <>
      <VotingPanel night={night} live={live} />
      <div className="flex flex-col gap-2">
        <ApiErrorNotice error={close.error} />
        <Button
          size="tap"
          data-testid="primary-action"
          disabled={close.isPending}
          onClick={() => close.mutate()}
        >
          {close.isPending ? "Closing…" : "Close voting"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Closing counts the votes and reveals the winner on the TV.
        </p>
      </div>
    </>
  );
}

function WinnerStage({ night }: { night: Night }) {
  const [confirming, setConfirming] = useState(false);
  const end = useNightMutation<void>(night.id, async () => {
    const next = await api.closeNight(night.id);
    forgetNightCode(night.id);
    return next;
  });
  const winner = night.options.find((o) => o.id === night.result?.winner_option_id);
  if (!winner || !night.result) return null;

  return (
    <section aria-labelledby="winner" className="flex flex-col gap-4">
      <h2 id="winner" className="flex items-center gap-2 text-xl font-semibold">
        <Trophy aria-hidden className="size-5 text-cinema" /> Tonight&apos;s movie
      </h2>
      <div className="flex items-center gap-4 rounded-2xl bg-card p-4 marquee-glow">
        <Poster title={winner.title} posterPath={winner.poster_path} className="w-24 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-2xl font-semibold" data-testid="winner-title">
            {winner.title}
          </p>
          {winner.year ? <p className="text-muted-foreground">{winner.year}</p> : null}
          <p className="text-sm text-muted-foreground">
            {night.result.ballot_count} {night.result.ballot_count === 1 ? "vote" : "votes"}
          </p>
        </div>
      </div>
      {night.status === "tonight" ? (
        <>
          <Button size="tap" data-testid="primary-action" onClick={() => setConfirming(true)}>
            End the night
          </Button>
          <p className="text-sm text-muted-foreground">
            Ending the night stops the code from letting phones in.
          </p>
        </>
      ) : null}
      {confirming ? (
        // owner-portal.md §7 copy.up.endConfirm; destructive actions confirm (§4 rule 6).
        <ModalDialog
          title="End the night?"
          onClose={() => setConfirming(false)}
          testId="end-night-confirm"
        >
          <p>Phones stop joining with tonight&apos;s code. Photos and ratings stay open.</p>
          <ApiErrorNotice error={end.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="lg"
              className="px-4"
              disabled={end.isPending}
              onClick={() => end.mutate(undefined, { onSuccess: () => setConfirming(false) })}
            >
              {end.isPending ? "Ending…" : "End the night"}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  );
}

/**
 * Start/Stop for the paired TV's slideshow (issue #41). The app can't know when the movie ends
 * (it plays on Netflix or Plex), so the host says when. The TV hears `status_changed` and
 * switches without a reload; never pressing it leaves the TV on `auto` (slideshow-control.ts).
 */
function SlideshowControl({ night }: { night: Night }) {
  const action = hostAction(night.slideshow);
  const set = useNightMutation<boolean>(night.id, (playing) => api.setSlideshow(night.id, playing));
  return (
    <section
      aria-labelledby="tv-slideshow-heading"
      className="flex flex-col gap-3"
      data-testid="slideshow-control"
      data-mode={night.slideshow}
    >
      <h2 id="tv-slideshow-heading" className="flex items-center gap-2 text-xl font-semibold">
        <Images aria-hidden className="size-5" /> Photos on the TV
      </h2>
      <ApiErrorNotice error={set.error} />
      <Button
        size="tap"
        variant={action.playing ? "default" : "outline"}
        disabled={set.isPending}
        onClick={() => set.mutate(action.playing)}
      >
        {action.playing ? null : <Square aria-hidden className="fill-current" />}
        {set.isPending ? "Telling the TV…" : action.label}
      </Button>
      <p className="text-sm text-muted-foreground" role="status" data-testid="slideshow-status">
        {hostStatus(night.slideshow)}
      </p>
    </section>
  );
}
