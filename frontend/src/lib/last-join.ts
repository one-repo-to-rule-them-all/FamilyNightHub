/**
 * The household this browser last joined (guest-flow spec §5 S0, `fnh.lastJoin`). A phone whose
 * cookie was cleared lands on `/` with nothing to tap; with this it gets **Join The Baez Family**
 * instead. Only the public join slug (a door, not a key, ADR-0002) and the household's name are
 * kept, never a night code. Every access is guarded like `night-code-handoff.ts`.
 */

const KEY = "fnh.lastJoin";

export type LastJoin = { slug: string; householdName: string | null };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function rememberLastJoin(join: LastJoin): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(join));
  } catch {
    // Quota or disabled storage: the landing page just shows the "Scan the QR" screen.
  }
}

/** The stored value as a string (stable between renders, for `useSyncExternalStore`). */
export function readLastJoinRaw(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function parseLastJoin(raw: string | null): LastJoin | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LastJoin> | null;
    if (!value || typeof value.slug !== "string" || !value.slug) return null;
    const householdName = typeof value.householdName === "string" ? value.householdName : null;
    return { slug: value.slug, householdName };
  } catch {
    return null;
  }
}

export function recallLastJoin(): LastJoin | null {
  return parseLastJoin(readLastJoinRaw());
}

/** `copy.s0.rejoin`: "Join The Baez Family", or a plain "Join movie night" before we know. */
export function rejoinLabel(join: LastJoin): string {
  return join.householdName ? `Join ${join.householdName}` : "Join movie night";
}
