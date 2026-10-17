"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Tv } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { type ApiError, enrollDevice } from "@/lib/api";

/**
 * ADR-0002 "Use as TV" confirm: mints a TV for this browser and clears the signed-in account here,
 * so a TV left in the living room never holds host rights. With `sessionId` it lands on that
 * night's TV screen; a night code just created stays in this tab's sessionStorage, which is how
 * it reaches the TV. Mounted only while open (ModalDialog); the caller unmounts it from `onClose`.
 *
 * Used by Settings → This browser and by Home's Up-next card (via its `onUseAsTv` prop).
 */
export function UseAsTvDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const enroll = useMutation<unknown, ApiError>({
    mutationFn: () => enrollDevice({ as_tv: true, device_label: "Living-room TV" }),
    onSuccess: () => {
      queryClient.clear();
      router.replace(sessionId ? `/tv/${sessionId}` : "/tv");
    },
  });

  return (
    <ModalDialog title="Make this browser the TV?" onClose={onClose} testId="use-as-tv-confirm">
      <p className="text-sm">
        This browser becomes the living-room TV and <strong>you&apos;re signed out here</strong>.
        Sign in again on your phone to keep running the night.
      </p>
      <ApiErrorNotice error={enroll.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="lg"
          className="px-4"
          disabled={enroll.isPending}
          onClick={() => enroll.mutate()}
        >
          {enroll.isPending ? "Pairing…" : "Yes, make it the TV"}
        </Button>
        <Button variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </ModalDialog>
  );
}

/** Settings → This browser: the once-per-TV action, behind its confirm. */
export function UseAsTvSection() {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-medium">
        <Tv aria-hidden className="size-4" /> Use this browser as the TV
      </p>
      <p className="text-sm text-muted-foreground">
        Open this page on the TV&apos;s browser, then turn it into the living-room TV. This signs
        you out here.
      </p>
      <Button
        variant="secondary"
        size="lg"
        className="self-start px-4"
        onClick={() => setConfirming(true)}
        data-testid="use-as-tv"
      >
        Use as the TV…
      </Button>
      {confirming ? <UseAsTvDialog sessionId={null} onClose={() => setConfirming(false)} /> : null}
    </div>
  );
}
