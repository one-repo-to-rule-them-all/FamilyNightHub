/**
 * The portal shell's pure logic (proposals/owner-portal.md §3): the nav badges, the account line
 * and the shell's own copy. A sibling of `portal.ts` (piece B owns that file); it only composes
 * `portal.ts` helpers, so the badge always counts the same rows Home's inbox shows (AC-P2.7).
 */

import { type InboxItem, type NavKey, type NightLike, type Role, inboxIsUrgent } from "./portal";

export type Badge = { count: number; urgent: boolean };

/** Where Home stores the night ids hidden from `unrated` (same key as Home's). */
export const HIDDEN_UNRATED_KEY = "fnh.portal.hiddenUnrated";

/** The badge sources poll at Home's inbox cadence (the claims poll). */
export const BADGE_POLL_MS = 10_000;

/** Nights the stats and the unrated rows read (Home's filter). */
const PAST_STATUSES: readonly NightLike["status"][] = ["revealed", "tonight", "closed"];

export function pastNights<T extends NightLike>(nights: T[]): T[] {
  return nights.filter((n) => PAST_STATUSES.includes(n.status));
}

/**
 * Home counts every inbox row; People counts PIN requests and locked profiles. The accent is for
 * someone standing there waiting: any claim or PIN request on Home, a PIN request on People.
 */
export function navBadges(items: InboxItem[]): Partial<Record<NavKey, Badge>> {
  const people = items.filter((item) => item.kind === "pin-reset" || item.kind === "locked");
  const badges: Partial<Record<NavKey, Badge>> = {};
  if (items.length > 0) badges.home = { count: items.length, urgent: inboxIsUrgent(items) };
  if (people.length > 0) {
    badges.people = {
      count: people.length,
      urgent: people.some((item) => item.kind === "pin-reset"),
    };
  }
  return badges;
}

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", host: "Host" };

/** "Rodolfo · Admin" under the sidebar, above Sign out. */
export function accountLine(account: { display_name: string; role: Role }): string {
  return `${account.display_name} · ${ROLE_LABEL[account.role]}`;
}
