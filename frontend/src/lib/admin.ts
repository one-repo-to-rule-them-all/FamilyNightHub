/**
 * The admin screens' pure logic (04-frontend.md "Admin"). React-free so it is unit-tested to 100%.
 *
 * - People: the avatar colour palette, form checks that mirror the API's (app/schemas/admin.py,
 *   so a typo is caught before the round trip; the API stays the authority), the PATCH body with
 *   only what changed, and the merge result as one sentence.
 * - Devices: a display name and a "last seen" phrase.
 * - Settings: age caps, the region code, and the streaming-services selection (at most 20).
 */

/**
 * The person colours an admin can pick: the avatar palette (ADR-0008 keeps the UI to one accent;
 * these are data colours, only ever behind an avatar emoji at 45%). The API takes any `#rrggbb`
 * and stores it lowercase, so the values here are lowercase too.
 */
export const PERSON_COLORS = [
  { name: "Pink", value: "#ec4899" },
  { name: "Purple", value: "#a855f7" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Green", value: "#22c55e" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Orange", value: "#f97316" },
] as const;

export type ColorChoice = { name: string; value: string };

/** The palette, plus the person's current colour when it isn't one of them (kept pickable). */
export function colorChoices(current?: string | null): ColorChoice[] {
  const palette: ColorChoice[] = [...PERSON_COLORS];
  if (!current) return palette;
  const value = current.toLowerCase();
  return palette.some((c) => c.value === value)
    ? palette
    : [...palette, { name: "Current colour", value }];
}

/** A few one-tap avatars; any emoji can be typed instead. */
export const EMOJI_SUGGESTIONS = ["🦄", "🦖", "🐼", "🦊", "🐸", "🐙", "🦁", "🐧", "🌟", "🎸"];

const MAX_NAME = 60;
const MAX_EMOJI = 16;

/** Trim and collapse inner whitespace, as the API does. */
export function cleanName(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

export type PersonDraft = { name: string; avatarEmoji: string; color: string };
export type PersonErrors = { name?: string; avatarEmoji?: string; color?: string };

/** The API's rules, checked early. Empty object = OK to send. */
export function validatePerson(draft: PersonDraft): PersonErrors {
  const errors: PersonErrors = {};
  const name = cleanName(draft.name);
  if (!name) errors.name = "Give them a name.";
  else if (name.length > MAX_NAME) errors.name = `Keep it to ${MAX_NAME} characters.`;

  const emoji = draft.avatarEmoji.trim();
  const chars = [...emoji];
  const asciiOnly = chars.every((ch) => ch.charCodeAt(0) < 128);
  if (!emoji || /\s/.test(emoji) || asciiOnly || chars.length > MAX_EMOJI) {
    errors.avatarEmoji = "Pick one emoji.";
  }
  if (!/^#[0-9a-f]{6}$/i.test(draft.color)) errors.color = "Pick a colour.";
  return errors;
}

type PersonFields = { name: string; avatar_emoji: string; color: string };

/** The PATCH body: only the fields that changed (cleaned), or null when nothing did. */
export function personChanges(
  original: PersonFields,
  draft: PersonDraft,
): Partial<PersonFields> | null {
  const changes: Partial<PersonFields> = {};
  const name = cleanName(draft.name);
  const emoji = draft.avatarEmoji.trim();
  const color = draft.color.toLowerCase();
  if (name !== original.name) changes.name = name;
  if (emoji !== original.avatar_emoji) changes.avatar_emoji = emoji;
  if (color !== original.color.toLowerCase()) changes.color = color;
  return Object.keys(changes).length > 0 ? changes : null;
}

type MergeCounts = {
  ballot_ranks_moved: number;
  ballot_ranks_dropped: number;
  ratings_moved: number;
  ratings_dropped: number;
  photos_moved: number;
  reactions_moved: number;
  reactions_dropped: number;
  bindings_moved: number;
  bindings_dropped: number;
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Moved 3 ballot picks, 1 rating and 2 photos to Sam." plus what collided and was dropped. */
export function describeMerge(result: MergeCounts, intoName: string): string {
  const moved = [
    [result.ballot_ranks_moved, "ballot pick", "ballot picks"],
    [result.ratings_moved, "rating", "ratings"],
    [result.photos_moved, "photo", "photos"],
    [result.reactions_moved, "reaction", "reactions"],
    [result.bindings_moved, "phone", "phones"],
  ] as const;
  const dropped = [
    [result.ballot_ranks_dropped, "ballot pick", "ballot picks"],
    [result.ratings_dropped, "rating", "ratings"],
    [result.reactions_dropped, "reaction", "reactions"],
    [result.bindings_dropped, "phone link", "phone links"],
  ] as const;
  const list = (items: readonly (readonly [number, string, string])[]) =>
    joinAnd(items.filter(([n]) => n > 0).map(([n, one, many]) => count(n, one, many)));

  const movedText = list(moved);
  let sentence = movedText
    ? `Moved ${movedText} to ${intoName}.`
    : `Nothing to move: ${intoName} is unchanged.`;
  const droppedText = list(dropped);
  if (droppedText) sentence += ` Dropped ${droppedText} that ${intoName} already had.`;
  return sentence;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The label, else what it is. */
export function deviceName(device: { label: string | null; is_tv: boolean }): string {
  return device.label ?? (device.is_tv ? "Living-room TV" : "Unnamed phone");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "5 min ago", "3 h ago", "2 days ago"; "Never" when it hasn't been seen. */
export function lastSeen(iso: string | null, now: Date): string {
  if (!iso) return "Never";
  const ago = Math.max(0, now.getTime() - new Date(iso).getTime());
  if (ago < MINUTE) return "Just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  const days = Math.floor(ago / DAY);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export const AGE_CAPS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
export type AgeCapValue = (typeof AGE_CAPS)[number];
/** The `<select>` value for "no cap" (the API's null). */
export const NO_AGE_CAP = "none";

export function ageCapFromSelect(value: string): AgeCapValue | null {
  return (AGE_CAPS as readonly string[]).includes(value) ? (value as AgeCapValue) : null;
}

/** ISO 3166-1 alpha-2, uppercased, or null when it isn't two letters. */
export function normalizeRegion(value: string): string | null {
  const region = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(region) ? region : null;
}

/** PATCH /admin/settings takes at most this many (app/schemas/admin.py). */
export const MAX_STREAMING_PROVIDERS = 20;

/** Tick or untick a service; ticking past the limit changes nothing. Sorted, like the API. */
export function toggleProvider(
  selected: readonly number[],
  providerId: number,
  max = MAX_STREAMING_PROVIDERS,
): number[] {
  if (selected.includes(providerId)) return selected.filter((id) => id !== providerId);
  if (selected.length >= max) return [...selected];
  return [...selected, providerId].sort((a, b) => a - b);
}

/** Same set, ignoring order (to enable "Save" only when something changed). */
export function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
