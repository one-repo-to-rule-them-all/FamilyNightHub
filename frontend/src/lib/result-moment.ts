/**
 * The win and lose moment (ADR-0018 amendment 2026-11-26). A pure decision of what the phone's
 * current person sees when a game ends: `won`, `lost`, or nothing (`null`). Null while the game is
 * not `ended`, when nobody won, and for a person who never joined. The component in
 * `components/games/result-moment.tsx` renders it once per person per game on a device.
 */

export type ResultOutcome = "won" | "lost";

export interface ResultPerson {
  person_id: string;
  name: string;
  avatar_emoji: string;
  color: string;
}

export interface ResultDecision {
  outcome: ResultOutcome;
  /** Everyone who won, in finishing order (ties included). */
  winners: ResultPerson[];
  /** The pattern ("Line") or the points ("12 points") that won. */
  detail: string | null;
}

export interface PlacedPlayer extends ResultPerson {
  won: boolean;
  finish_place: number | null;
}

export interface Standing extends ResultPerson {
  points: number;
}

type Status = "draft" | "open" | "live" | "ended";

function decide<T extends ResultPerson>(
  personId: string | null | undefined,
  joined: readonly ResultPerson[],
  winners: readonly T[],
  detail: string | null,
): ResultDecision | null {
  if (!personId || winners.length === 0) return null;
  if (!joined.some((p) => p.person_id === personId)) return null;
  const outcome = winners.some((w) => w.person_id === personId) ? "won" : "lost";
  return { outcome, winners: [...winners], detail };
}

/** Bingo (classic and Thanksgiving) and Lotería: whoever has `won`, by finishing place. */
export function placedResult(
  status: Status | undefined,
  personId: string | null | undefined,
  players: readonly PlacedPlayer[],
  pattern: string | null,
): ResultDecision | null {
  if (status !== "ended") return null;
  const winners = players
    .filter((p) => p.won)
    .sort((a, b) => (a.finish_place ?? 0) - (b.finish_place ?? 0));
  return decide(personId, players, winners, pattern);
}

/** "1 point" / "12 points". */
export function pointsLabel(points: number): string {
  return `${points} ${points === 1 ? "point" : "points"}`;
}

/**
 * Scattergories: the top of the leaderboard once the game ended; everyone tied at the top won.
 * A game where nobody scored has no winner. `joined` is the snapshot's players list.
 */
export function scatterResult(
  status: Status | undefined,
  personId: string | null | undefined,
  joined: readonly ResultPerson[],
  leaderboard: readonly Standing[],
): ResultDecision | null {
  if (status !== "ended") return null;
  const winners = scatterWinners(leaderboard);
  if (winners.length === 0) return null;
  const everyone = [...joined, ...leaderboard];
  return decide(personId, everyone, winners, pointsLabel(winners[0].points));
}

/** Everyone tied at the top of the leaderboard; empty when nobody scored. */
export function scatterWinners<T extends Standing>(leaderboard: readonly T[]): T[] {
  if (leaderboard.length === 0) return [];
  const top = Math.max(...leaderboard.map((s) => s.points));
  return top > 0 ? leaderboard.filter((s) => s.points === top) : [];
}

/** "Sam" / "Sam and Kim" / "A, B and C". */
export function namesList(people: readonly { name: string }[]): string {
  const names = people.map((p) => p.name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The losing card's kind line: "Sam won this one." / "Sam and Kim won this one." */
export function whoWonLine(winners: readonly { name: string }[]): string {
  return `${namesList(winners)} won this one.`;
}

/** The localStorage key that marks a moment as seen for this person in this game. */
export function seenKey(gameId: string, personId: string): string {
  return `fn:result-moment:${gameId}:${personId}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True once the moment was shown for this person and game on this device. Storage errors: false. */
export function hasSeen(gameId: string, personId: string, store = storage()): boolean {
  try {
    return store?.getItem(seenKey(gameId, personId)) === "1";
  } catch {
    return false;
  }
}

/** Marks the moment as seen; a storage error (private mode, quota) is ignored. */
export function markSeen(gameId: string, personId: string, store = storage()): void {
  try {
    store?.setItem(seenKey(gameId, personId), "1");
  } catch {
    /* the moment may replay on reload; never break the page for it */
  }
}

export const SOUND_KEY = "fn:result-moment:sound";

export function soundEnabled(store = storage()): boolean {
  try {
    return store?.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean, store = storage()): void {
  try {
    store?.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* per-device convenience only */
  }
}
