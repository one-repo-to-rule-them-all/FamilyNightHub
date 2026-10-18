"use client";

import { useQuery } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { POLL_MS } from "@/hooks/use-live-session";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { api, type ApiError, type NightSummary } from "@/lib/api";
import { DEVICE_EXPIRED_COPY, isDeviceExpired } from "@/lib/device-idle";

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

/** /tv: waits for tonight's night and jumps to it; explains pairing to an unpaired browser. */
export function TvHome() {
  const router = useRouter();
  const current = useCurrentNight();
  useWakeLock();

  const target = current.data?.id ?? null;
  useEffect(() => {
    if (target) router.replace(`/tv/${target}`);
  }, [target, router]);

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
        {current.isPending || target
          ? "Getting tonight ready…"
          : "Waiting for the host to start a night."}
      </p>
    </div>
  );
}
