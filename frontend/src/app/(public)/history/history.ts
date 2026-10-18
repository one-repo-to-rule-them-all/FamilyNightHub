import type { ProfileNight, Schemas } from "@/lib/api";

/**
 * History (guest-home §5 H2): the tab in the URL and what a *Mine* row says. React-free so it is
 * unit-tested on its own. Copy is guest-home §7 (`copy.h.hist.*`); the strings `HOME_COPY` already
 * carries come from there, the rest live here.
 */

export type HistoryTab = "mine" | "family";

export const HISTORY_COPY = {
  picks: (titles: string) => `Your picks: ${titles}`,
  approved: (n: number) => `You liked ${n}`,
  turnout: (n: number) => `${n} voted`,
} as const;

/** `?tab=` → the tab; anything but `family` is Mine (the default). */
export function historyTab(raw: string | null | undefined): HistoryTab {
  return raw === "family" ? "family" : "mine";
}

/** `copy.h.hist.mineSummary`, as parts so the numbers can be bold. Null average drops its part. */
export function mineSummary(
  stats: Pick<
    Schemas["ProfileStatsOut"],
    "nights_joined" | "winners_picked" | "average_rating_given"
  >,
): { prefix?: string; value: string; label: string }[] {
  const parts: { prefix?: string; value: string; label: string }[] = [
    { value: String(stats.nights_joined), label: stats.nights_joined === 1 ? "night" : "nights" },
    {
      value: String(stats.winners_picked),
      label: stats.winners_picked === 1 ? "winning pick" : "winning picks",
    },
  ];
  if (stats.average_rating_given !== null) {
    parts.push({ prefix: "★", value: stats.average_rating_given.toFixed(1), label: "average" });
  }
  return parts;
}

/** The picks line: top three in rank order, or "You liked N" for an approval night. */
export function picksLine(night: Pick<ProfileNight, "picks" | "voting_method">): string | null {
  if (night.picks.length === 0) return null;
  if (night.voting_method === "approval") return HISTORY_COPY.approved(night.picks.length);
  const titles = [...night.picks]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
    .map((pick) => pick.movie.title);
  return HISTORY_COPY.picks(titles.join(", "));
}

/** A **Rate it** button shows while the night can be rated (`tonight`/`closed`) and isn't yet. */
export function canRate(night: Pick<ProfileNight, "status" | "rating">): boolean {
  return night.rating === null && (night.status === "tonight" || night.status === "closed");
}
