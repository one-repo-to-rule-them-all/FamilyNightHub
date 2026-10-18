"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError, type Night, type VotingMethod } from "@/lib/api";
import { cn } from "@/lib/utils";
import { VOTING_METHODS } from "@/lib/voting-method";

/**
 * How the family votes tonight (ADR-0010). A new night starts with the household default; the
 * host can switch while the night is a draft. Opening voting locks it with the shortlist.
 */
export function VotingMethodPicker({ night }: { night: Night }) {
  const queryClient = useQueryClient();
  // Set in the click's own event: the mutation's pending state lands a tick later, and until then
  // the controlled radio snapped back to the old method for a frame (flaky in e2e, #42).
  const [wanted, setWanted] = useState<VotingMethod | null>(null);
  const change = useMutation<Night, ApiError, VotingMethod>({
    mutationFn: (method) => api.setVotingMethod(night.id, method),
    onSuccess: (next) => queryClient.setQueryData(nightKey(night.id), next),
    onSettled: () => setWanted(null),
  });
  const current = wanted ?? night.voting_method;

  return (
    <fieldset className="flex flex-col gap-3" data-testid="voting-method">
      <legend className="mb-3 text-xl font-semibold">How we vote</legend>
      {VOTING_METHODS.map((method) => (
        <label
          key={method.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring",
            current === method.value && "ring-2 ring-foreground",
          )}
        >
          <input
            type="radio"
            name="voting-method"
            value={method.value}
            checked={current === method.value}
            disabled={change.isPending}
            onChange={() => {
              setWanted(method.value);
              change.mutate(method.value);
            }}
            className="mt-1 size-5 accent-primary"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-lg font-medium">{method.label}</span>
            <span className="text-muted-foreground">{method.explanation}</span>
          </span>
        </label>
      ))}
      <ApiErrorNotice error={change.error} />
    </fieldset>
  );
}
