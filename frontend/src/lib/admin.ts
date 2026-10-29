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

/** What the People table needs of a person (ADR-0014 adds `has_pin` / `locked`). */
export type PersonStatusLike = { is_guest: boolean; has_pin: boolean; locked: boolean };

/** The Status column (owner-portal spec §5 P3): a lock outranks having a PIN. */
export type PersonStatus = "locked" | "no-pin" | "pin-set";

export const PERSON_STATUS_LABEL: Record<PersonStatus, string> = {
  locked: "Locked",
  "no-pin": "No PIN yet",
  "pin-set": "PIN set",
};

export function personStatus(person: PersonStatusLike): PersonStatus {
  if (person.locked) return "locked";
  return person.has_pin ? "pin-set" : "no-pin";
}

/**
 * How a People row offers **Reset PIN** (#88): up front when locked out, quietly when a PIN is
 * set (a forgotten one), and not at all before anyone chose a PIN (nothing to reset).
 */
export function resetPinEmphasis(person: PersonStatusLike): "prominent" | "quiet" | null {
  switch (personStatus(person)) {
    case "locked":
      return "prominent";
    case "pin-set":
      return "quiet";
    default:
      return null;
  }
}

/** Under "Reset {name}'s PIN?" when an admin resets directly, on People and Home (#88). */
export const RESET_PIN_NOTE = "They'll choose a new one on their phone.";

/** Locked out, or nobody has chosen a PIN yet: the "Needs attention" filter. */
export function needsAttention(person: PersonStatusLike): boolean {
  return personStatus(person) !== "pin-set";
}

export const PEOPLE_FILTERS = [
  { key: "all", label: "All" },
  { key: "family", label: "Family" },
  { key: "guests", label: "Guests" },
  { key: "attention", label: "Needs attention" },
] as const;

export type PeopleFilter = (typeof PEOPLE_FILTERS)[number]["key"];

export function filterPeople<T extends PersonStatusLike>(people: T[], filter: PeopleFilter): T[] {
  switch (filter) {
    case "family":
      return people.filter((p) => !p.is_guest);
    case "guests":
      return people.filter((p) => p.is_guest);
    case "attention":
      return people.filter(needsAttention);
    default:
      return people;
  }
}

/** "Ava and Leo", or "4 people" once a list of names stops being readable. */
function nameList(names: string[]): string {
  return names.length <= 3 ? joinAnd(names) : `${names.length} people`;
}

/**
 * Why the "Needs attention · N" filter counts N, said in words under it. No-PIN people are not an
 * inbox row (nothing for the admin to do: each picks a PIN on their phone), so without this line
 * the count reads like an unexplained alert. Null when nobody needs attention.
 */
export function attentionLine(people: (PersonStatusLike & { name: string })[]): string | null {
  const locked = people.filter((p) => personStatus(p) === "locked").map((p) => p.name);
  const noPin = people.filter((p) => personStatus(p) === "no-pin").map((p) => p.name);
  const parts: string[] = [];
  if (noPin.length > 0) {
    const verb = noPin.length === 1 ? "hasn't" : "haven't";
    parts.push(
      `${nameList(noPin)} ${verb} set a PIN yet. Nothing to do here: they choose one on their ` +
        "phone the next time they pick their name.",
    );
  }
  if (locked.length > 0) {
    const verb = locked.length === 1 ? "is" : "are";
    parts.push(
      `${nameList(locked)} ${verb} locked after 5 wrong PINs. Tap Reset PIN on their row, and ` +
        "they choose a new one on their phone.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** "6 people · 5 family, 1 guest" under the People header. */
export function peopleSummary(people: PersonStatusLike[]): string {
  const guests = people.filter((p) => p.is_guest).length;
  const family = people.length - guests;
  return `${count(people.length, "person", "people")} · ${family} family, ${count(guests, "guest", "guests")}`;
}

/** `#person-{id}` (the inbox's "See profile" link) → the id, else null. */
export function personIdFromHash(hash: string): string | null {
  const match = /^#person-(.+)$/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
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

/** What removing a person deletes (#94), as the API previews it. */
export type RemovalCountsLike = {
  nights_voted: number;
  ratings: number;
  photos: number;
  reactions: number;
  phones: number;
};

/** The Remove dialog's sentence: "This deletes their votes on 2 nights, 1 rating and 3 photos."
 *  A person with nothing yet gets a plainer line. */
export function describeRemoval(name: string, c: RemovalCountsLike): string {
  const parts = [
    c.nights_voted > 0 ? `their votes on ${count(c.nights_voted, "night", "nights")}` : null,
    c.ratings > 0 ? count(c.ratings, "rating", "ratings") : null,
    c.photos > 0 ? count(c.photos, "photo they shared", "photos they shared") : null,
    c.reactions > 0 ? count(c.reactions, "reaction", "reactions") : null,
    c.phones > 0 ? `their link to ${count(c.phones, "phone", "phones")}` : null,
  ].filter((p): p is string => p !== null);
  const what = parts.length
    ? `This also deletes ${joinAnd(parts)}.`
    : `${name} hasn't voted, rated or shared anything yet.`;
  return `${what} Past winners stay. This can't be undone.`;
}

/** Start fresh (#94) is armed only when the typed name matches the family's, ignoring case and
 *  spaces at either end, the same way the API checks it. */
export function startFreshArmed(typed: string, familyName: string): boolean {
  return (
    typed.trim().toLocaleLowerCase() === familyName.trim().toLocaleLowerCase() && !!typed.trim()
  );
}

/** "Cleared 4 people, 6 phones and 5 nights." */
export function describeStartFresh(c: {
  people: number;
  phones: number;
  nights: number;
  photos: number;
}): string {
  const parts = [
    count(c.people, "person", "people"),
    count(c.phones, "phone", "phones"),
    count(c.nights, "night", "nights"),
  ];
  if (c.photos > 0) parts.push(count(c.photos, "photo", "photos"));
  return `Cleared ${joinAnd(parts)}. Add people on People to start again.`;
}
