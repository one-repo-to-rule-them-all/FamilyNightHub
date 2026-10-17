/**
 * Ratings on the phone (04-frontend.md "Ratings"). React-free so it is unit-tested to 100%.
 *
 * - Who still owes a rating: the people this phone holds (`binding: "mine"`) whose score is null.
 * - The family average as one short line ("4.5 from 2 ratings").
 * - "Not now" on the home card: remembered per night in `localStorage`, so the card stays away
 *   for that night only. Every storage access is guarded (private mode, disabled storage): the
 *   card then simply shows again next time.
 */

export const SCORES = [1, 2, 3, 4, 5] as const;
export type Score = (typeof SCORES)[number];

type BoundPerson = { id: string; binding: string };
type OwnScore = { person_id: string; score: number | null };
type Summary = { average: number | null; count: number };

/** People this phone holds who haven't rated the night yet, in the people list's order. */
export function unratedPeople<P extends BoundPerson>(people: P[], ratings: OwnScore[]): P[] {
  const rated = new Set(ratings.filter((r) => r.score !== null).map((r) => r.person_id));
  return people.filter((p) => p.binding === "mine" && !rated.has(p.id));
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
