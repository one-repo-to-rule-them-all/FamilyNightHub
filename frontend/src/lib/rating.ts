/**
 * Ratings on the phone (04-frontend.md "Ratings"). React-free so it is unit-tested to 100%.
 *
 * - Who may rate (issue #91): only someone who took part in the night, present or voted. The
 *   backend says so per person on `/ratings/mine` (`attended`) and refuses anyone else with 403
 *   `not_attended`; everyone else sees the night's ratings read-only, with `NOT_ATTENDED`.
 * - Who still owes a rating: the people this phone holds (`binding: "mine"`) who took part and
 *   whose score is null.
 * - The family average as one short line ("4.5 from 2 ratings").
 * - "Not now" on the home card: remembered per night in `localStorage`, so the card stays away
 *   for that night only. Every storage access is guarded (private mode, disabled storage): the
 *   card then simply shows again next time.
 */

export const SCORES = [1, 2, 3, 4, 5] as const;
export type Score = (typeof SCORES)[number];

type BoundPerson = { id: string; binding: string };
type OwnScore = { person_id: string; score: number | null; attended: boolean };
type Summary = { average: number | null; count: number };

/** What a phone shows instead of the stars for a night that person wasn't part of. */
export const NOT_ATTENDED = "You weren't at this one.";

/**
 * Whether `personId` may rate the night, from its `/ratings/mine` row. `undefined` while the
 * ratings load; false without a row (this phone doesn't hold them, so it can't rate as them).
 */
export function mayRate(
  ratings: readonly Pick<OwnScore, "person_id" | "attended">[] | undefined,
  personId: string,
): boolean | undefined {
  if (!ratings) return undefined;
  return ratings.some((r) => r.person_id === personId && r.attended);
}

/** People this phone holds who took part in the night and haven't rated it yet, in order. */
export function unratedPeople<P extends BoundPerson>(people: P[], ratings: OwnScore[]): P[] {
  const owed = new Set(
    ratings.filter((r) => r.attended && r.score === null).map((r) => r.person_id),
  );
  return people.filter((p) => p.binding === "mine" && owed.has(p.id));
}

/** "4.5 from 2 ratings", or null when there is nothing to show yet. */
export function describeAverage(rating: Summary | null | undefined): string | null {
  if (!rating || rating.average === null || rating.count === 0) return null;
  const noun = rating.count === 1 ? "rating" : "ratings";
  return `${rating.average.toFixed(1)} from ${rating.count} ${noun}`;
}

/**
 * How far the family is through rating a night, for the night page's Ratings panel and the
 * portal inbox's `unrated` row ("2 of 4 rated"). `turnout` is the night's ballot count; someone
 * who rated without voting still counts, so `of` never drops below `rated`.
 */
export function ratingProgress(
  rating: Summary | null | undefined,
  turnout: number,
): { rated: number; of: number; done: boolean } {
  const rated = rating?.count ?? 0;
  const of = Math.max(turnout, rated);
  return { rated, of, done: of > 0 && rated >= of };
}

const PREFIX = "fnh.ratePromptDismissed.";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function dismissRatePrompt(sessionId: string): void {
  try {
    storage()?.setItem(PREFIX + sessionId, "1");
  } catch {
    // Quota or disabled storage: the card comes back next time, which is harmless.
  }
}

export function isRatePromptDismissed(sessionId: string): boolean {
  try {
    return storage()?.getItem(PREFIX + sessionId) === "1";
  } catch {
    return false;
  }
}
