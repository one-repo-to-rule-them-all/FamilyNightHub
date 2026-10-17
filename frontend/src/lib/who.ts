import type { NightSummary } from "@/lib/api";

/** How often the who-are-you screen re-checks for a live night (also refetched on tab focus).
 *  A phone often lands there before the host opens voting and must not be left without the
 *  "Vote now" button once it opens (staging bug, 2026-10-17). */
export const LIVE_NIGHT_POLL_MS = 5_000;

/** The line under "You're in as …", matching the night's real state. */
export function statusHint(status: NightSummary["status"] | undefined): string {
  if (status === "voting") return "Voting is open: tap Vote now.";
  if (status === "revealed" || status === "tonight") return "Tonight's movie is picked.";
  return "Waiting for the host to open voting.";
}
