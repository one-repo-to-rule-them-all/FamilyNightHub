/**
 * Lotería logic (ADR-0018 amendment 2026-11-26): labels and ordering shared by the phone, host and
 * TV screens. React-free so it is unit-tested. The server decides what is called and who wins;
 * nothing here does.
 */

import type { StripPlayer } from "@/lib/game-layout";
import { cardById } from "@/lib/loteria-deck";

export type LoteriaPattern = "line" | "corners" | "center" | "full";

export const TABLA_SIZE = 4;
export const DECK_TOTAL = 54;
/** What a player shouts. */
export const SHOUT = "¡Lotería!";

export const PATTERN_COPY: Record<LoteriaPattern, { name: string; blurb: string }> = {
  line: { name: "Line", blurb: "Any row, column or diagonal wins." },
  corners: { name: "Four corners", blurb: "The four corner pictures." },
  center: { name: "Centre four", blurb: "The four pictures in the middle." },
  full: { name: "Full tabla (¡Lotería!)", blurb: "Every picture on the tabla." },
};

export interface LoteriaPlayerLike {
  person_id: string;
  name: string;
  missing: number;
  won: boolean;
  finish_place: number | null;
}

export interface CallLike {
  seq: number;
  card_id: number;
}

/** A player's distance from winning: "¡Lotería!", "1 away", "4 to go". */
export function progressLabel(player: Pick<LoteriaPlayerLike, "missing" | "won">): string {
  if (player.won || player.missing === 0) return SHOUT;
  if (player.missing === 1) return "1 away";
  return `${player.missing} to go`;
}

/** Winners by finishing place, then everyone by how close they are, then by name. */
export function rankPlayers<T extends LoteriaPlayerLike>(players: readonly T[]): T[] {
  return [...players].sort((a, b) => {
    if (a.won !== b.won) return a.won ? -1 : 1;
    if (a.won && b.won) return (a.finish_place ?? 0) - (b.finish_place ?? 0);
    return a.missing - b.missing || a.name.localeCompare(b.name);
  });
}

export function winnerNames(players: readonly LoteriaPlayerLike[]): string[] {
  return rankPlayers(players)
    .filter((p) => p.won)
    .map((p) => p.name);
}

/** "Sam got ¡Lotería!" / "Sam and Kim got ¡Lotería!" */
export function winnerLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} got ${SHOUT}`;
}

export function calledSet(calls: readonly CallLike[]): ReadonlySet<number> {
  return new Set(calls.map((c) => c.card_id));
}

/** The cards called just before the latest one, newest first (at most `count`). */
export function recentCalls<T extends CallLike>(calls: readonly T[], count = 5): T[] {
  return calls.slice(0, -1).slice(-count).reverse();
}

export function markedSet(marked: readonly number[]): ReadonlySet<number> {
  return new Set(marked);
}

/** Can a square be marked? Only a called card, and only while the round is live. */
export function canMark(status: string, cardId: number, called: ReadonlySet<number>): boolean {
  return status === "live" && called.has(cardId);
}

/** Screen-reader label for one square: "Row 2, column 3: La Sirena, called, marked". */
export function squareLabel(
  cardId: number,
  index: number,
  isCalled: boolean,
  isMarked: boolean,
): string {
  const row = Math.floor(index / TABLA_SIZE) + 1;
  const column = (index % TABLA_SIZE) + 1;
  const state = `${isCalled ? "called" : "not called yet"}, ${isMarked ? "marked" : "not marked"}`;
  return `Row ${row}, column ${column}: ${cardById(cardId).es}, ${state}`;
}

/** What a tap on a square that cannot be marked says. */
export function notCalledMessage(cardId: number, status: string): string {
  if (status !== "live") return "The round hasn't started.";
  return `${cardById(cardId).es} hasn't been called yet.`;
}

/** The phone's one line under the title for each state of the round. */
export function statusLine(status: string, joined: boolean, calls: number): string {
  if (status === "draft") return "The host is getting ready.";
  if (status === "open") {
    return joined
      ? "You are in. Not happy with your tabla? Get another until the host starts."
      : "Take a seat to get your tabla.";
  }
  if (status === "live") {
    return calls === 0
      ? "Waiting for the first card…"
      : `${calls} of ${DECK_TOTAL} called. Tap a picture when it's called.`;
  }
  return "That round is over.";
}

export interface CheckResultLike {
  valid: boolean;
  missing: number;
}

/** The host's inline answer to a check: "Valid: ¡Lotería!" or "Not yet: 2 away". */
export function checkResultLine(name: string, result: CheckResultLike): string {
  if (result.valid) return `${name}: valid. ${SHOUT}`;
  return `${name}: not yet, ${result.missing === 1 ? "1 away" : `${result.missing} to go`}.`;
}

interface StripSource extends LoteriaPlayerLike {
  avatar_emoji: string;
  color: string;
}

/** Footer-strip players. `progress: false` hides "2 away" (the TV: it would spoil the suspense). */
export function loteriaStripPlayers(
  players: readonly StripSource[],
  options: { progress?: boolean } = {},
): StripPlayer[] {
  const progress = options.progress ?? true;
  return players.map((p) => ({
    id: p.person_id,
    name: p.name,
    emoji: p.avatar_emoji,
    color: p.color,
    chip: progress || p.won ? progressLabel(p) : undefined,
    highlight: p.won,
  }));
}
