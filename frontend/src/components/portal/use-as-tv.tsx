"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Tv } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { type ApiError, enrollDevice } from "@/lib/api";
import { handNightCodeTo } from "@/lib/night-code-handoff";

/** One named tab, so a second tap reuses the TV tab instead of stacking new ones. */
export const TV_WINDOW_NAME = "fnh-tv";

/**
 * Opens the blank TV tab. No features string: any features ask the browser for a sized popup
 * window, and the host wants an ordinary new tab they can drag to the TV (issue #69).
 */
export function openTvTab(open: Window["open"] = window.open.bind(window)): Window | null {
  return open("", TV_WINDOW_NAME);
}

type Opened = { win: Window | null; sessionId: string };

/** The TV screen for a night (device auth only; it never links back into the portal). */
export function tvHref(sessionId: string): string {
  return `/tv/${encodeURIComponent(sessionId)}`;
}

/**
 * After enrollment: point the blank window at the TV screen, handing it the night code this tab
 * holds. Returns the href to offer as a plain link when there is no window (a popup blocker ate
 * it, or the host closed it while pairing), else null.
 */
export function sendTvWindowTo(win: Window | null, sessionId: string): string | null {
  const href = tvHref(sessionId);
  if (!win || win.closed) return href;
  handNightCodeTo(win, sessionId);
  win.location.replace(href);
  win.focus();
  return null;
}

/**
 * ADR-0002 amendment 2026-10-18 "Open TV window": the host's laptop drives the living-room TV
 * from a second tab and stays signed in in this one.
 *
 * The tab is opened synchronously inside the click (a popup blocker only allows that), on a
 * blank page; then this browser is enrolled as the TV with `keep_session`, and only then does the
 * window navigate to `/tv/{night}`, so the TV never flashes "not paired". The TV screens send
 * the device-only header (lib/api.ts), so that window runs on the TV device even though the
 * cookie jar also holds the host session. If the blocker ate the window, `fallbackHref` is set
 * and the caller shows a plain link instead.
 */
export function useTvWindow() {
  const [fallbackHref, setFallbackHref] = useState<string | null>(null);
  const enroll = useMutation<unknown, ApiError, Opened>({
    mutationFn: () =>
      enrollDevice({ as_tv: true, keep_session: true, device_label: "Living-room TV" }),
    onSuccess: (_, { win, sessionId }) => setFallbackHref(sendTvWindowTo(win, sessionId)),
    onError: (_, { win }) => win?.close(),
  });

  const open = (sessionId: string) => {
    setFallbackHref(null);
    const win = openTvTab();
    enroll.mutate({ win, sessionId });
  };

  return { open, pending: enroll.isPending, error: enroll.error, fallbackHref };
}

/**
 * "Open TV window" for one night: Home's Up-next card and the night page. One tap, no confirm:
 * nothing here signs anyone out (unlike Settings → "Use this browser as the TV").
 */
export function OpenTvWindowButton({ sessionId }: { sessionId: string }) {
  const tv = useTvWindow();
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        size="lg"
        className="self-start px-3.5"
        disabled={tv.pending}
        onClick={() => tv.open(sessionId)}
        data-testid="open-tv-window"
      >
        <Tv aria-hidden /> {tv.pending ? "Opening the TV…" : "Open TV window"}
      </Button>
      <ApiErrorNotice error={tv.error} />
      {tv.fallbackHref ? (
        <p className="text-sm" role="status" data-testid="tv-window-blocked">
          Your browser blocked the new tab.{" "}
          <a
            href={tv.fallbackHref}
            target={TV_WINDOW_NAME}
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            Open the TV screen <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </p>
      ) : null}
    </div>
  );
}

/**
 * ADR-0002 "Use as TV" confirm, for a screen that is *only* the TV (a smart-TV browser): mints a TV for this browser and clears the signed-in account here,
 * so a TV left in the living room never holds host rights. With `sessionId` it lands on that
 * night's TV screen; a night code just created stays in this tab's sessionStorage, which is how
 * it reaches the TV. Mounted only while open (ModalDialog); the caller unmounts it from `onClose`.
 *
 * Used by Settings → This browser. The host's own laptop uses `OpenTvWindowButton` instead.
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
    mutationFn: () =>
      enrollDevice({ as_tv: true, keep_session: false, device_label: "Living-room TV" }),
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
