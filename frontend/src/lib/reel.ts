/**
 * Night reel helpers (ADR-0018 amendment "Night reel"): which slide is on show, and the words a
 * slide carries. The index uses the jar's `cycleIndex` arithmetic, so there are no tick events:
 * each snapshot has the server's clock, an anchor and a dwell, and the screen works the rest out.
 * Pure, React-free.
 */

import type { Schemas } from "@/lib/api";
import { cycleIndex } from "@/lib/jar-cycle";

export type ReelData = Schemas["ReelOut"];
export type ReelItem = Schemas["ReelItemOut"];
export type ReelWindow = ReelData["window"];

/** How often the TV refetches so a new winner or quote joins the show (events stay hints). */
export const REEL_POLL_MS = 30_000;

/** `?window=all` shows everything ever; anything else is "tonight". */
export function parseWindow(raw: string | null | undefined): ReelWindow {
  return raw === "all" ? "all" : "tonight";
}

/** The slide index at `nowMs` on this device's clock, given the snapshot's server clock. */
export function reelIndex(
  nowMs: number,
  reel: Pick<ReelData, "server_now" | "anchor" | "dwell_seconds">,
  fetchedAtMs: number,
  count: number,
): number {
  // The server/device offset is taken once per snapshot, at the moment it arrived.
  const offsetMs = Date.parse(reel.server_now) - fetchedAtMs;
  return cycleIndex(
    (nowMs + offsetMs) / 1000,
    Date.parse(reel.anchor) / 1000,
    reel.dwell_seconds,
    count,
    null,
  );
}

/** "3 of 14" (1-based), empty for an empty reel. */
export function reelProgress(index: number, count: number): string {
  return count <= 0 ? "" : `${index + 1} of ${count}`;
}

/** Names as "Ana", "Ana and Ben", "Ana, Ben and Cy". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const PLACE = ["", "first", "second", "third"];

/** The big line of a winner slide. */
export function winnerHeadline(item: ReelItem): string {
  const names = nameList(item.winners.map((w) => w.name));
  const many = item.winners.length > 1;
  if (item.game_kind === "bingo") {
    const place = item.place ?? 1;
    return place === 1
      ? `${names} got BINGO!`
      : `${names} got bingo, ${PLACE[place] ?? `#${place}`}!`;
  }
  return many ? `${names} tied for the win!` : `${names} won the round!`;
}

/** A readable one-line description of a slide, for the live region and tests. */
export function slideSummary(item: ReelItem): string {
  switch (item.kind) {
    case "quote":
      return item.body ?? "";
    case "winner":
      return winnerHeadline(item);
    case "leaderboard":
      return `${item.game_title ?? "Leaderboard"}: ${item.standings
        .map((s) => `${s.person.name} ${s.points}`)
        .join(", ")}`;
    case "photo":
      return item.photo_by ? `A photo from ${item.photo_by.name}` : "A photo";
  }
}
