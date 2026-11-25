"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, QrCode } from "lucide-react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { api, type ApiError } from "@/lib/api";

/**
 * Host control: send this game to the paired TV (/tv follows it), or send the TV back to its
 * QR home. The host's own tab stays where it is; the TV is a separate device (ADR-0018).
 */
export function ShowOnTvButton({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  // Hosts' tabs read the same snapshot the TV does (a host account is a viewer too).
  const target = useQuery<string | null, ApiError>({
    queryKey: ["tv-target", "host"],
    queryFn: async () => (await api.tvTarget()).game_id,
    refetchInterval: 5_000,
  });
  const showing = target.data === gameId;
  const toggle = useMutation<unknown, ApiError>({
    mutationFn: () => api.setTvTarget(showing ? null : gameId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tv-target"] }),
  });

  return (
    <>
      <Button
        variant="secondary"
        data-testid="show-on-tv"
        data-showing={showing}
        disabled={target.isPending || toggle.isPending}
        onClick={() => toggle.mutate()}
      >
        {showing ? <QrCode aria-hidden /> : <Monitor aria-hidden />}
        {showing ? "Back to QR" : "Show on TV"}
      </Button>
      <ApiErrorNotice error={toggle.error} />
    </>
  );
}
