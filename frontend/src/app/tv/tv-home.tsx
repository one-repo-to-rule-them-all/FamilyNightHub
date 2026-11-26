"use client";

import { useQuery } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { POLL_MS } from "@/hooks/use-live-session";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { api, type ApiError, type GameSummary, type NightSummary } from "@/lib/api";
import { DEVICE_EXPIRED_COPY, isDeviceExpired } from "@/lib/device-idle";
import { releasedGames, shouldReturnToEnded } from "@/lib/tv-hold";
import { useTvTargetState } from "@/lib/tv-target";

/** Nights the TV should be showing, newest first. A closed night is history, not the TV's job. */
const ON_SCREEN = ["draft", "voting", "revealed", "tonight"] as const;

export function useCurrentNight() {
  return useQuery<NightSummary | null, ApiError>({
    queryKey: ["nights", "current"],
    queryFn: async () => (await api.nights({ status: [...ON_SCREEN], limit: 1 }))[0] ?? null,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
}

/** Open or live games, newest first: what /tv shows when nothing else is on (ADR-0018). */
function useOpenGame() {
  return useQuery<GameSummary | null, ApiError>({
    queryKey: ["games", "on-tv"],
    queryFn: async () =>
      (await api.games()).find((g) => g.status === "open" || g.status === "live") ?? null,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
}

/** What the paired TV is following right now, for the copy on the home screen. */
type Following = "sent-game" | "night" | "game" | "none";

/**
 * /tv follows, in order: a game the host sent to the TV, a live night, any open or live game,
 * else this home screen (ADR-0018 amendment "The TV follows the host"). Polls only: every
 * answer is a snapshot, so nothing depends on having seen an event.
 */
export function TvHome() {
  const router = useRouter();
  const current = useCurrentNight();
  const sent = useTvTargetState();
  const openGame = useOpenGame();
  useWakeLock();

  const settled = !current.isPending && !sent.isPending;
  let path: string | null = null;
  let following: Following = "none";
  if (sent.data?.game_id) {
    path = `/tv/games/${sent.data.game_id}`;
    following = "sent-game";
  } else if (sent.data?.ended_game_id && shouldReturnToEnded(sent.data, releasedGames)) {
    // A sent game that just ended: its result screen holds for a while (lib/tv-hold.ts).
    path = `/tv/games/${sent.data.ended_game_id}`;
    following = "sent-game";
  } else if (current.data?.id) {
    path = `/tv/${current.data.id}`;
    following = "night";
  } else if (settled && openGame.data) {
    path = `/tv/games/${openGame.data.id}`;
    following = "game";
  }
  useEffect(() => {
    if (path) router.replace(path);
  }, [path, router]);

  if (current.error?.status === 401) {
    // Unused for 30 days (issue #56): the same pairing, said as "again".
    const expired = isDeviceExpired(current.error);
    return (
      <div
        className="m-auto flex max-w-[40em] flex-col gap-[1em] text-center"
        data-testid="tv-unpaired"
        data-expired={expired || undefined}
      >
        <h1 className="tv-title">
          {expired ? DEVICE_EXPIRED_COPY.tvTitle : "This screen isn't paired yet"}
        </h1>
        <p className="tv-body text-muted-foreground">
          {expired ? `${DEVICE_EXPIRED_COPY.tv} ` : null}A host signs in here, then chooses{" "}
          <strong>Use this browser as the TV</strong>
          {expired ? " again" : null}.
        </p>
        <Link
          href="/login"
          className="tv-body mx-auto rounded-xl bg-primary px-[1em] py-[0.5em] font-medium text-primary-foreground"
        >
          Host sign-in
        </Link>
      </div>
    );
  }

  return (
    <div
      className="m-auto flex flex-col items-center gap-[1em] text-center"
      data-live={current.isError ? "reconnecting" : current.isSuccess ? "ready" : "connecting"}
    >
      <Clapperboard aria-hidden className="size-[5em] text-muted-foreground" />
      <h1 className="tv-title">Family Night</h1>
      <p className="tv-body text-muted-foreground" data-testid="tv-waiting">
        {!settled || path ? "Getting tonight ready…" : "Waiting for the host to start a night."}
      </p>
      <p
        className="tv-body text-muted-foreground"
        data-testid="tv-following"
        data-following={following}
      >
        {following === "sent-game"
          ? "Showing the game the host picked."
          : following === "night"
            ? "Following tonight's movie night."
            : following === "game"
              ? "Following the open game."
              : "This screen follows the host: a game sent to the TV, tonight's movie night, or an open game."}
      </p>
    </div>
  );
}
