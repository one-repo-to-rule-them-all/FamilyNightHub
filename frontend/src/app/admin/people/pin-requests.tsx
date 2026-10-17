"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { lastSeen } from "@/lib/admin";
import { api, type ApiError, type PinReset } from "@/lib/api";

export const PIN_RESETS_KEY = ["admin", "pin-resets"] as const;
/** The owner portal polls open requests (spec §5 "Admin": the nav badge, every 10 s). */
export const PIN_RESETS_POLL_MS = 10_000;

/** Open "Forgot PIN" requests. Admins only (`admin:people`); a host's 403 shows nothing. */
export function usePinResets() {
  return useQuery<PinReset[], ApiError>({
    queryKey: PIN_RESETS_KEY,
    queryFn: api.pinResets,
    // A host gets 403 (admins only): stop asking.
    refetchInterval: (query) => (query.state.error?.status === 403 ? false : PIN_RESETS_POLL_MS),
    retry: false,
  });
}

/**
 * The nav badge's open-request count (G4): a cheap count, not the list. Under `PIN_RESETS_KEY`, so
 * approving or dismissing a request refreshes it too. A host's 403 stops the polling.
 */
export function usePinResetCount() {
  return useQuery<number, ApiError>({
    queryKey: [...PIN_RESETS_KEY, "count"],
    queryFn: async () => (await api.pinResetCount()).open_count,
    refetchInterval: (query) => (query.state.error?.status === 403 ? false : PIN_RESETS_POLL_MS),
    retry: false,
  });
}

/**
 * "PIN requests" at the top of /admin/people (guest-flow spec §5 "Admin", owner decision §10.2:
 * only admins reset PINs). **Reset PIN** clears the PIN and the lock without showing or choosing
 * one; the phone that asked then picks a new PIN by itself. **Dismiss** leaves the lock.
 */
export function PinRequests({ onNotice }: { onNotice: (notice: string) => void }) {
  const queryClient = useQueryClient();
  const requests = usePinResets();
  const [confirming, setConfirming] = useState<PinReset | null>(null);
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: PIN_RESETS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["admin", "people"] });
  };
  const approve = useMutation<PinReset, ApiError, PinReset>({
    mutationFn: (request) => api.approvePinReset(request.id),
    onSuccess: (request) => {
      setConfirming(null);
      settle();
      onNotice(
        `Reset ${request.person_name}'s PIN. They'll choose a new one on the phone that asked.`,
      );
    },
  });
  const dismiss = useMutation<PinReset, ApiError, PinReset>({
    mutationFn: (request) => api.dismissPinReset(request.id),
    onSuccess: (request) => {
      settle();
      onNotice(`Dismissed ${request.person_name}'s request.`);
    },
  });

  if (requests.isError) {
    return requests.error.status === 403 ? null : <ApiErrorNotice error={requests.error} />;
  }
  const open = requests.data ?? [];
  const now = new Date();

  return (
    <section id="pin-requests" aria-labelledby="pin-requests-title" className="flex flex-col gap-3">
      <h2 id="pin-requests-title" className="text-lg font-semibold">
        PIN requests
        {open.length > 0 ? (
          <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-sm text-primary-foreground">
            {open.length}
          </span>
        ) : null}
      </h2>
      {requests.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading requests…
        </p>
      ) : open.length === 0 ? (
        <p className="text-muted-foreground" data-testid="pin-requests-empty">
          Nobody is waiting for a PIN reset.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="pin-requests">
          {open.map((request) => (
            <li
              key={request.id}
              className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10"
            >
              <Avatar emoji={request.avatar_emoji} color="#64748b" className="size-10 text-2xl" />
              <div className="min-w-40 flex-1">
                <p className="font-medium">
                  {request.person_name}
                  {request.person_locked ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-sm text-muted-foreground">
                      <Lock aria-hidden className="size-3.5" />
                      Locked
                    </span>
                  ) : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  asked {lastSeen(request.requested_at, now).toLowerCase()} from{" "}
                  {request.device_label ?? "an unnamed phone"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="lg"
                  className="px-4"
                  onClick={() => {
                    approve.reset();
                    setConfirming(request);
                  }}
                >
                  Reset PIN
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="px-4"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(request)}
                >
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ApiErrorNotice error={dismiss.error} />
      {confirming ? (
        <ModalDialog
          title={
            <>
              Reset <strong>{confirming.person_name}</strong>&apos;s PIN?
            </>
          }
          onClose={() => setConfirming(null)}
          testId="pin-reset-confirm"
        >
          <p>Their old PIN stops working. They&apos;ll choose a new one on the phone that asked.</p>
          <ApiErrorNotice error={approve.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              className="px-4"
              disabled={approve.isPending}
              onClick={() => approve.mutate(confirming)}
            >
              {approve.isPending ? "Resetting…" : "Reset PIN"}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  );
}
