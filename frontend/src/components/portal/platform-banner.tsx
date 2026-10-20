"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { type ApiError, type PlatformMe, api } from "@/lib/api";

/**
 * ADR-0016 §8: fixed while a platform operator is inside a household, never dismissable, in a
 * color no household theme uses, so "mine or theirs" is always obvious. Exit drops the binding
 * and every cached query (they belong to that household) and returns to /platform.
 */
export function PlatformBanner({ householdName }: { householdName: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const exit = useMutation<PlatformMe, ApiError, void>({
    mutationFn: api.exitHousehold,
    onSuccess: () => {
      queryClient.removeQueries();
      router.replace("/platform");
    },
  });
  return (
    <div
      role="status"
      data-testid="platform-banner"
      className="sticky top-0 z-40 flex items-center justify-between gap-3 bg-fuchsia-700 px-4 py-2 text-sm text-white"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ShieldAlert aria-hidden className="size-4 shrink-0" />
        <span className="truncate">
          Platform access: <strong>{householdName}</strong>. The family sees this in its activity.
        </span>
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md px-3 py-1 font-semibold ring-1 ring-white/60 hover:bg-white/10"
        disabled={exit.isPending}
        onClick={() => exit.mutate()}
      >
        {exit.isPending ? "Leaving…" : "Exit"}
      </button>
    </div>
  );
}
