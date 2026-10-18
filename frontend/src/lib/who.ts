/**
 * The phone's resolver and the "Who's watching?" tiles (guest-flow spec §3, §5 S2).
 *
 * Every phone screen derives from three facts: does this phone have a device, who is it acting as
 * (the tile with `current`, ADR-0014), and what is the household's live night. `resolve` is the
 * only place that decides where a phone goes, so a stale screen re-resolves instead of waiting.
 */
import { EMOJI_SUGGESTIONS, PERSON_COLORS } from "@/lib/admin";
import type { NightStatus, NightSummary, PersonTile } from "@/lib/api";
import { POLL_MS } from "@/lib/live";

/** How often a waiting screen re-checks for a live night (also refetched on tab focus). */
export const LIVE_NIGHT_POLL_MS = 5_000;

/** Nights a phone lands on. `draft` too, so an early phone sits on "Almost ready" (D11). */
export const LIVE_NIGHT_STATUSES: NightStatus[] = ["draft", "voting", "revealed", "tonight"];

export type Resolution =
  | { screen: "who" }
  | { screen: "no-night"; person: PersonTile }
  | { screen: "night"; person: PersonTile; sessionId: string };

/** Where this phone belongs right now. A current person without a PIN must set one first (S2). */
export function resolve(
  people: readonly PersonTile[],
  liveNight: Pick<NightSummary, "id"> | undefined,
): Resolution {
  const person = currentPerson(people);
  if (!person) return { screen: "who" };
  if (liveNight) return { screen: "night", person, sessionId: liveNight.id };
  return { screen: "no-night", person };
}

/** The person this phone acts as: `current`, holding a PIN, and not locked out of the binding. */
export function currentPerson(people: readonly PersonTile[] | undefined): PersonTile | null {
  return people?.find((p) => p.current && p.binding === "mine" && p.has_pin) ?? null;
}

/**
 * Who a rating, photo or reaction can be from on this phone: the current person only (ADR-0014;
 * the API answers 403 "Switch to them on this phone first" for anyone else it holds).
 */
export function actingPeople<T extends PersonTile>(people: readonly T[] | undefined): T[] {
  const current = currentPerson(people);
  return current ? [current as T] : [];
}

/** Family first, then guests, each in the server's order (spec §5 S2). */
export function orderTiles<T extends Pick<PersonTile, "is_guest">>(people: readonly T[]): T[] {
  return [...people.filter((p) => !p.is_guest), ...people.filter((p) => p.is_guest)];
}

/** The people this phone holds, the current one first (the switch sheet). */
export function phonePeople(people: readonly PersonTile[]): PersonTile[] {
  const mine = people.filter((p) => p.binding === "mine");
  return [...mine.filter((p) => p.current), ...mine.filter((p) => !p.current)];
}

/**
 * What tapping a tile does (spec §5 S2 table):
 * - `current`: nothing to ask, back to the resolver;
 * - `enter`: S3e, type their PIN (a claim or a switch);
 * - `create`: S3c, choose a first PIN (new person, legacy binding, or a reset approved here);
 * - `ask-host`: S4, they have no PIN and are on another phone, so a host must OK this one;
 * - `pending`: S4, already waiting for the host;
 * - `locked`: S5; `reset-pending`: S6, the family admin was already asked.
 */
export type TileAction =
  "current" | "enter" | "create" | "ask-host" | "pending" | "locked" | "reset-pending";

export function tileAction(person: PersonTile): TileAction {
  if (person.current && person.has_pin) return "current";
  if (person.pin_reset === "approved_for_this_phone") return "create";
  if (person.pin_reset === "open") return "reset-pending";
  if (person.locked) return "locked";
  if (person.binding === "pending") return "pending";
  if (person.has_pin) return "enter";
  return person.binding === "taken" ? "ask-host" : "create";
}

/** The tile's badge text (`copy` tile badges), or null for a plain tile. */
export function tileBadge(person: PersonTile): string | null {
  if (person.current && person.has_pin) return "That's you";
  if (person.locked) return "Locked";
  if (person.binding === "pending") return "Waiting for the host";
  if (person.binding === "taken") return "On another phone";
  if (person.has_pin) return null;
  return person.binding === "mine" ? "Needs a PIN" : "New";
}

/**
 * `/who`'s people `refetchInterval` (gap G5: approvals publish nothing to a phone). Poll while a
 * claim waits for a host or a PIN reset waits for the family admin.
 */
export function waitingPollInterval(people: readonly PersonTile[] | undefined): number | false {
  const waiting = people?.some((p) => p.binding === "pending" || p.pin_reset === "open");
  return waiting ? POLL_MS : false;
}

/** Self-create's picture choices: the admin suggestions, 8 one-tap emoji (spec §5 S7). */
export const GUEST_EMOJI = EMOJI_SUGGESTIONS.slice(0, 8);

/** A new guest's colour comes from the avatar palette by name, with no picker (spec §5 S7). */
export function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return PERSON_COLORS[hash % PERSON_COLORS.length].value;
}

export const NAME_MAX = 40;

/** A self-created name: trimmed, 1–40 characters, or null while it can't be one. */
export function cleanGuestName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}

export type WaitingNotice = "rejected" | "not-waiting" | "dismissed" | "other-phone";
export type FollowResult =
  | { kind: "done" }
  | { kind: "grid"; notice?: WaitingNotice }
  | { kind: "pin"; mode: "enter" | "create"; notice?: WaitingNotice }
  | { kind: "locked"; notice?: WaitingNotice };

/**
 * Whether a waiting screen may act on the people list yet. Asking the host (S4) or the admin (S6)
 * opens the screen before the list refetches, and the tile it still holds predates the request
 * (`taken`, no `pin_reset`): read as an answer, that is an instant "the host said no". So the
 * screen follows only data fetched at or after it opened (`since`, from `Date.now()`).
 */
export function canFollow(since: number | undefined, dataUpdatedAt: number): boolean {
  return since === undefined || dataUpdatedAt >= since;
}

/**
 * Where a waiting screen goes once the server moved on, or null to keep waiting (spec §5 S4, S6).
 * - S4 (`pending`): approved → the resolver (`done`) or the PIN. No longer pending → the grid:
 *   with `copy.s4.rejected` only if this wait saw the claim pending (`sawPending`), since a claim
 *   that never became pending was not rejected by anyone (staging, #42); otherwise
 *   `copy.s4.notWaiting`.
 * - S6 (`reset`): approved for this phone → choose a new PIN; dismissed → S5 with
 *   `copy.s6.dismissed`; reset from another phone → type the new PIN (`copy.s6.otherPhone`).
 */
export function followWaiting(
  waiting: "pending" | "reset",
  person: PersonTile | undefined,
  sawPending = true,
): FollowResult | null {
  if (!person) return { kind: "grid" };
  if (waiting === "pending") {
    if (person.binding === "pending") return null;
    if (person.binding === "mine" && person.current && person.has_pin) return { kind: "done" };
    if (person.binding === "mine")
      return { kind: "pin", mode: person.has_pin ? "enter" : "create" };
    if (person.locked) return { kind: "locked" };
    return { kind: "grid", notice: sawPending ? "rejected" : "not-waiting" };
  }
  if (person.pin_reset === "approved_for_this_phone") return { kind: "pin", mode: "create" };
  if (person.pin_reset === "open") return null;
  if (person.locked) return { kind: "locked", notice: "dismissed" };
  if (!person.has_pin) return { kind: "pin", mode: "create" };
  return { kind: "pin", mode: "enter", notice: "other-phone" };
}
