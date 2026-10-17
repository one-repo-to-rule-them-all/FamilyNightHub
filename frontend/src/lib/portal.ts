/**
 * The owner portal's pure logic (proposals/owner-portal.md). React-free so it is unit-tested to
 * 100%: which nav items a role sees, the Up-next card's state, the attention inbox (merge,
 * priority, thresholds, badge count), the quick stats and the greeting.
 *
 * Inputs are structural subsets of the API types, so this file compiles against today's
 * generated schema and against ADR-0014's (PIN resets, `has_pin`, `locked`) alike.
 */

export type Role = "admin" | "host";
export type NightStatus = "draft" | "voting" | "revealed" | "tonight" | "closed";

// ---------------------------------------------------------------------------------------------
// Navigation (§3.1)

export type NavKey = "home" | "people" | "phones" | "library" | "history" | "settings";
export type NavItem = { key: NavKey; href: string; label: string; adminOnly: boolean };

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", href: "/host", label: "Home", adminOnly: false },
  { key: "people", href: "/admin/people", label: "People", adminOnly: true },
  { key: "phones", href: "/admin/devices", label: "Phones", adminOnly: true },
  { key: "library", href: "/admin/movies", label: "Library", adminOnly: true },
  { key: "history", href: "/admin/history", label: "History", adminOnly: false },
  { key: "settings", href: "/admin/settings", label: "Settings", adminOnly: false },
];

export function navFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => role === "admin" || !item.adminOnly);
}

/** Phone bottom tabs: at most four items plus More (§3.2). */
export function phoneTabs(role: Role): { tabs: NavItem[]; more: NavItem[] } {
  const items = navFor(role);
  const tabKeys: NavKey[] =
    role === "admin" ? ["home", "people", "library", "history"] : ["home", "history"];
  return {
    tabs: items.filter((item) => tabKeys.includes(item.key)),
    more: items.filter((item) => !tabKeys.includes(item.key)),
  };
}

/** The nav item a pathname belongs to; a night being run (`/host/{id}`) counts as Home. */
export function activeNav(pathname: string): NavKey | null {
  if (pathname === "/host" || pathname.startsWith("/host/")) return "home";
  const match = NAV_ITEMS.find(
    (item) =>
      item.key !== "home" && (pathname === item.href || pathname.startsWith(`${item.href}/`)),
  );
  return match?.key ?? null;
}

// ---------------------------------------------------------------------------------------------
// Up next (§5 P1a)

export type NightLike = {
  id: string;
  status: NightStatus;
  title: string | null;
  created_at: string;
};

export type UpNext =
  | { kind: "none" }
  | { kind: "created"; nightId: string }
  | { kind: "draft"; nightId: string; ready: boolean }
  | { kind: "voting"; nightId: string }
  | { kind: "tonight"; nightId: string };

export const ACTIVE_STATUSES: readonly NightStatus[] = ["draft", "voting", "revealed", "tonight"];
export const MIN_SHORTLIST = 2;

/** The newest active night, which the card follows; the rest are "Also running". */
export function splitActive<T extends NightLike>(nights: T[]): { current: T | null; others: T[] } {
  const active = nights
    .filter((n) => ACTIVE_STATUSES.includes(n.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { current: active[0] ?? null, others: active.slice(1) };
}

/**
 * `createdId` is the night this browser just created (its code is shown once); `optionCount` is
 * the current night's shortlist size from its snapshot, unknown while that loads.
 */
export function upNextState(
  current: NightLike | null,
  options: { createdId?: string | null; optionCount?: number | null } = {},
): UpNext {
  if (!current) return { kind: "none" };
  if (current.status === "draft") {
    if (options.createdId === current.id) return { kind: "created", nightId: current.id };
    return {
      kind: "draft",
      nightId: current.id,
      ready: (options.optionCount ?? 0) >= MIN_SHORTLIST,
    };
  }
  if (current.status === "voting") return { kind: "voting", nightId: current.id };
  return { kind: "tonight", nightId: current.id };
}

// ---------------------------------------------------------------------------------------------
// Attention inbox (§5 P2)

export type InboxKind = "pin-reset" | "claim" | "locked" | "stale-night" | "unrated";

export const INBOX_PRIORITY: Record<InboxKind, number> = {
  "pin-reset": 1,
  claim: 2,
  locked: 3,
  "stale-night": 4,
  unrated: 5,
};

export const STALE_NIGHT_MS = 18 * 60 * 60 * 1000;
export const UNRATED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const INBOX_PREVIEW = 5;

export type ClaimLike = {
  device_id: string;
  device_label: string | null;
  person_id: string;
  person_name: string;
  avatar_emoji: string;
  requested_at: string;
};
export type PinResetLike = {
  id: string;
  person_id: string;
  person_name: string;
  avatar_emoji: string;
  person_locked: boolean;
  device_label: string | null;
  requested_at: string;
  status: "open" | "approved" | "dismissed";
};
export type PersonLike = {
  id: string;
  name: string;
  avatar_emoji: string;
  color: string;
  locked?: boolean;
};
export type PastNightLike = NightLike & {
  closed_at: string | null;
  turnout: number;
  rating: { count: number; average: number | null } | null;
  winner: { title: string } | null;
};

export type InboxItem =
  | { kind: "pin-reset"; id: string; at: string; reset: PinResetLike }
  | { kind: "claim"; id: string; at: string; claim: ClaimLike }
  | { kind: "locked"; id: string; at: string; person: PersonLike }
  | { kind: "stale-night"; id: string; at: string; night: NightLike }
  | { kind: "unrated"; id: string; at: string; night: PastNightLike };

export type InboxSources = {
  role: Role;
  now: number;
  claims?: ClaimLike[];
  pinResets?: PinResetLike[];
  people?: PersonLike[];
  activeNights?: NightLike[];
  pastNights?: PastNightLike[];
  /** Night ids the owner hid from `unrated` on this browser. */
  hiddenUnrated?: readonly string[];
};

export function claimId(claim: Pick<ClaimLike, "device_id" | "person_id">): string {
  return `claim:${claim.device_id}:${claim.person_id}`;
}

/** Every pending decision, highest priority first, newest first within a kind. */
export function buildInbox(sources: InboxSources): InboxItem[] {
  const { role, now } = sources;
  const admin = role === "admin";
  const items: InboxItem[] = [];

  const openResets = admin ? (sources.pinResets ?? []).filter((r) => r.status === "open") : [];
  for (const reset of openResets) {
    items.push({ kind: "pin-reset", id: `reset:${reset.id}`, at: reset.requested_at, reset });
  }
  for (const claim of sources.claims ?? []) {
    items.push({ kind: "claim", id: claimId(claim), at: claim.requested_at, claim });
  }
  if (admin) {
    const asked = new Set(openResets.map((r) => r.person_id));
    for (const person of sources.people ?? []) {
      if (person.locked && !asked.has(person.id)) {
        items.push({ kind: "locked", id: `locked:${person.id}`, at: "", person });
      }
    }
  }
  for (const night of sources.activeNights ?? []) {
    if (
      ACTIVE_STATUSES.includes(night.status) &&
      now - Date.parse(night.created_at) > STALE_NIGHT_MS
    ) {
      items.push({ kind: "stale-night", id: `stale:${night.id}`, at: night.created_at, night });
    }
  }
  const hidden = new Set(sources.hiddenUnrated ?? []);
  for (const night of sources.pastNights ?? []) {
    if (isUnrated(night, now) && !hidden.has(night.id)) {
      items.push({
        kind: "unrated",
        id: `unrated:${night.id}`,
        at: night.closed_at as string,
        night,
      }); // isUnrated: closed_at is set
    }
  }

  return items.sort(
    (a, b) => INBOX_PRIORITY[a.kind] - INBOX_PRIORITY[b.kind] || b.at.localeCompare(a.at),
  );
}

/** A closed night from the last 14 days with fewer ratings than people who voted. */
export function isUnrated(night: PastNightLike, now: number): boolean {
  if (night.status !== "closed" || !night.closed_at || night.turnout === 0) return false;
  if (now - Date.parse(night.closed_at) > UNRATED_WINDOW_MS) return false;
  return (night.rating?.count ?? 0) < night.turnout;
}

/** Someone is standing there waiting (a phone claim or a PIN reset): the badge uses the accent. */
export function inboxIsUrgent(items: InboxItem[]): boolean {
  return items.some((item) => item.kind === "pin-reset" || item.kind === "claim");
}

/** The People nav badge: PIN requests plus locked profiles. */
export function peopleBadge(items: InboxItem[]): number {
  return items.filter((item) => item.kind === "pin-reset" || item.kind === "locked").length;
}

export function inboxPreview(items: InboxItem[], showAll: boolean): InboxItem[] {
  return showAll ? items : items.slice(0, INBOX_PREVIEW);
}

/** Adds or removes one id from the hidden-unrated list (stored per browser). */
export function toggleHidden(hidden: readonly string[], nightId: string): string[] {
  return hidden.includes(nightId) ? hidden.filter((id) => id !== nightId) : [...hidden, nightId];
}

/** Parses the stored hidden-unrated list, tolerating anything that isn't a string array. */
export function parseHidden(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Quick stats (§5 P1b)

export type Stats = {
  last: PastNightLike | null;
  thisMonth: number;
  /** Oldest → newest, at most 8. Empty when fewer than 2 nights (the tile hides). */
  turnout: number[];
};

export function stats(pastNights: PastNightLike[], now: Date): Stats {
  const newestFirst = [...pastNights].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const thisMonth = newestFirst.filter((n) => {
    const d = new Date(n.created_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const series = newestFirst
    .slice(0, 8)
    .map((n) => n.turnout)
    .reverse();
  return {
    last: newestFirst[0] ?? null,
    thisMonth,
    turnout: series.length >= 2 ? series : [],
  };
}

/** "4.3 from 3", or null before anyone rated. */
export function ratingLine(rating: PastNightLike["rating"]): string | null {
  if (!rating || rating.count === 0 || rating.average === null) return null;
  return `${rating.average.toFixed(1)} from ${rating.count}`;
}

// ---------------------------------------------------------------------------------------------
// Copy helpers

export function greeting(name: string, now: Date): string {
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = name.trim().split(/\s+/)[0] || name;
  return `Good ${part}, ${first}`;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------------------------
// Dashboard wiring (§5 P2, §6)

/** Where the hidden-unrated night ids live on this browser. */
export const HIDDEN_UNRATED_KEY = "fnh.portal.hiddenUnrated";

/** Inbox sources poll at the claims cadence while the tab is visible. */
export const INBOX_POLL_MS = 10_000;

export const ALREADY_DONE = "Someone already took care of that.";

/** Nights that have a winner: the stats and the unrated rows read only these. */
export const PAST_STATUSES: readonly NightStatus[] = ["revealed", "tonight", "closed"];

export function pastNights<T extends NightLike>(nights: T[]): T[] {
  return nights.filter((n) => PAST_STATUSES.includes(n.status));
}

/** A 404 or 409 on a row action means someone else resolved it first (AC-P2.8). */
export function isAlreadyDone(error: { status: number } | null | undefined): boolean {
  return error?.status === 404 || error?.status === 409;
}

/** Drops rows resolved on this screen before their source query has refetched. */
export function withoutResolved(items: InboxItem[], resolved: ReadonlySet<string>): InboxItem[] {
  return resolved.size === 0 ? items : items.filter((item) => !resolved.has(item.id));
}

/** The nav badge's accessible name ("{n} things need you"); null when nothing is waiting. */
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 thing needs you" : `${count} things need you`;
}
