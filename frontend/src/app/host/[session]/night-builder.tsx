"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import { nightKey, useNightPoll } from "@/hooks/use-night-poll";
import { api, type ApiError, type Night } from "@/lib/api";
import { forgetNightCode } from "@/lib/night-code-handoff";
import { canOpenVoting, MAX_OPTIONS, MIN_OPTIONS } from "@/lib/shortlist";

import { NightCodeCard } from "../night-code-card";
import { STATUS_LABEL } from "../status";
import { MovieSearch } from "./movie-search";
import { ShortlistEditor } from "./shortlist-editor";
import { VotingPanel } from "./voting-panel";

/** /host/[session]: shortlist → open voting → who has voted / proxy votes → close → winner. */
export function NightBuilder({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { night, live } = useNightPoll(sessionId);
  const signedOut = night.error?.status === 401;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (night.isPending || signedOut) {
    return <p className="text-lg text-muted-foreground">Loading…</p>;
  }
  if (!night.data) return <ApiErrorNotice error={night.error} />;

  const data = night.data;
  return (
    <div className="flex flex-col gap-8" data-live={live} data-status={data.status}>
      <div className="flex flex-col gap-1">
        <Link
          href="/host"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeft aria-hidden className="size-4" /> All nights
        </Link>
        <p className="text-2xl font-semibold">{data.title || "Movie night"}</p>
        <p className="text-muted-foreground" data-testid="night-status">
          {STATUS_LABEL[data.status]}
        </p>
      </div>

      {data.status === "draft" ? <DraftStage night={data} /> : null}
      {data.status === "voting" ? <VotingStage night={data} /> : null}
      {data.result ? <WinnerStage night={data} /> : null}

      {data.status !== "closed" ? <NightCodeCard sessionId={data.id} status={data.status} /> : null}
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
      <MovieSearch night={night} />
      <div className="flex flex-col gap-2">
        <ApiErrorNotice error={open.error} />
        <Button
          size="tap"
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

function VotingStage({ night }: { night: Night }) {
  const close = useNightMutation<void>(night.id, () => api.closeVoting(night.id));
  return (
    <>
      <VotingPanel night={night} />
      <div className="flex flex-col gap-2">
        <ApiErrorNotice error={close.error} />
        <Button size="tap" disabled={close.isPending} onClick={() => close.mutate()}>
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
          <ApiErrorNotice error={end.error} />
          <Button
            variant="outline"
            size="tap"
            disabled={end.isPending}
            onClick={() => end.mutate()}
          >
            {end.isPending ? "Ending…" : "End the night"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Ending the night stops the code from letting phones in.
          </p>
        </>
      ) : null}
    </section>
  );
}
