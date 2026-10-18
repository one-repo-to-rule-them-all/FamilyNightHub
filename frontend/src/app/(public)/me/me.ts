import type { PersonTile, Profile, Schemas } from "@/lib/api";
import { HOME_COPY } from "@/lib/home";
import { phonePeople } from "@/lib/who";

/**
 * Me (guest-home §5 H4) and the profile header: React-free, unit-tested on its own. Copy is
 * guest-home §7 (`copy.h.me.*`); `HOME_COPY.me` has the rest.
 */

/** `copy.h.me.since`: "Family since March 2026" or "Guest since…". */
export function memberSince(
  person: Pick<Profile, "is_guest" | "created_at">,
  locale?: string,
): string {
  const when = new Date(person.created_at).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
  return `${person.is_guest ? "Guest" : "Family"} since ${when}`;
}

/** Me's 2×2 stats, in reading order: nights, winning picks, average rating given, photos. */
export function meStats(
  stats: Schemas["ProfileStatsOut"],
): { label: string; value: string }[] {
  return [
    { label: "Movie nights", value: String(stats.nights_joined) },
    { label: "Winning picks", value: String(stats.winners_picked) },
    {
      label: "Average rating",
      value:
        stats.average_rating_given === null ? "—" : `${stats.average_rating_given.toFixed(1)} ★`,
    },
    { label: "Photos", value: String(stats.photos_uploaded) },
  ];
}

/** `copy.h.me.shared` up to the names ("Also on this phone:"), so each name can be a link. */
export const SHARED_LABEL = HOME_COPY.me.shared("").trimEnd();

/** The others this phone holds (`copy.h.me.shared`), not the current person. */
export function alsoOnPhone(people: readonly PersonTile[] | undefined): PersonTile[] {
  return phonePeople(people ?? []).filter((p) => !p.current);
}
