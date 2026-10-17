import type { Schemas } from "@/lib/api";

/** The profile's stat tiles, in reading order (ADR-0014 "Profiles"). */
export function profileStats(
  stats: Schemas["ProfileStatsOut"],
): { label: string; value: string }[] {
  return [
    { label: "Movie nights", value: String(stats.nights_joined) },
    { label: "Votes cast", value: String(stats.ballots_cast) },
    { label: "Winners picked", value: String(stats.winners_picked) },
    { label: "Photos added", value: String(stats.photos_uploaded) },
    { label: "Movies rated", value: String(stats.ratings_given) },
    {
      label: "Average rating",
      value:
        stats.average_rating_given === null ? "—" : `${stats.average_rating_given.toFixed(1)} ★`,
    },
  ];
}
