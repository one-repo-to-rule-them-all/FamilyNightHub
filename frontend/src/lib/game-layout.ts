/**
 * The game layout template's pure parts (04-frontend.md, "Game layout template"): the shape of one
 * player in the footer strip, how the strip densifies as the head count grows, and per-game
 * adapters from a snapshot to strip players. React-free so it is unit-tested.
 */

import { progressLabel } from "@/lib/bingo";
import { answeredLine } from "@/lib/scatter";

export type StripVariant = "tv" | "phone" | "host";

/** One player in the footer strip. `chip` is the per-game status ("2 away", "3 of 5 answered"). */
export interface StripPlayer {
  id: string;
  name: string;
  emoji: string;
  color: string;
  chip?: string;
  /** Winners get the cinema accent border (never colour alone: the chip says so too). */
  highlight?: boolean;
}

export type StripDensity = "roomy" | "compact" | "dense";

/** How tightly the strip packs: the more players, the smaller the chips (never fewer players). */
export function stripDensity(count: number): StripDensity {
  if (count <= 6) return "roomy";
  if (count <= 12) return "compact";
  return "dense";
}

/**
 * The strip's own height cap, as a number of chip rows it may show before it scrolls. Phones scroll
 * sideways in one row instead (a vertical strip would eat the stage); TV and host wrap up to this.
 */
export function stripMaxRows(variant: StripVariant, density: StripDensity): number {
  if (variant === "phone") return 1;
  if (density === "roomy") return 2;
  if (variant === "host") return density === "compact" ? 4 : 5;
  return density === "compact" ? 3 : 4;
}

/** The host's strip pins to the foot only while it is short; a crowd's would eat the screen. */
export function stripSticky(count: number): boolean {
  return stripDensity(count) === "roomy";
}

/** "1 player" / "3 players". */
export function playerCountLabel(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"}`;
}

interface BingoLike {
  person_id: string;
  name: string;
  avatar_emoji: string;
  color: string;
  squares_from_bingo: number;
  won: boolean;
}

/**
 * `progress: false` leaves out the "2 away" chip (classic bingo on the TV: it would spoil the
 * suspense); a winner still reads "Bingo!".
 */
export function bingoStripPlayers(
  players: readonly BingoLike[],
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

interface ScatterLike {
  person_id: string;
  name: string;
  avatar_emoji: string;
  color: string;
  answered: number;
}

/** `categories` is the running round's category count, or null between rounds (no chip then). */
export function scatterStripPlayers(
  players: readonly ScatterLike[],
  categories: number | null,
): StripPlayer[] {
  return players.map((p) => ({
    id: p.person_id,
    name: p.name,
    emoji: p.avatar_emoji,
    color: p.color,
    chip: categories === null ? undefined : answeredLine(p.answered, categories),
  }));
}

interface NoteLike {
  author?: { person_id?: string; name: string; avatar_emoji: string; color: string } | null;
}

/**
 * The jar has no player list on its snapshot (the server only says who wrote a note once it is
 * revealed, and never for an anonymous one), so its strip is the people behind revealed notes.
 */
export function jarStripPlayers(revealed: readonly NoteLike[]): StripPlayer[] {
  const seen = new Map<string, StripPlayer>();
  for (const note of revealed) {
    const a = note.author;
    if (!a) continue;
    const id = a.person_id ?? a.name;
    if (!seen.has(id)) {
      seen.set(id, {
        id,
        name: a.name,
        emoji: a.avatar_emoji,
        color: a.color,
        chip: "shared a note",
      });
    }
  }
  return [...seen.values()];
}

/** The widest a player's name may run in a strip chip (em), so one long name never owns a row. */
export function stripNameMaxEm(density: StripDensity): number {
  return density === "roomy" ? 14 : density === "compact" ? 10 : 8;
}

/**
 * How far to shrink a TV stage so all of it shows (a TV cannot scroll): 1 when it fits, else the
 * tighter of the two axes, never below `min` (past that the text would be unreadable from the
 * sofa, so the stage is left to clip rather than shrink to nothing). Zero sizes mean "not
 * measured yet" and give 1.
 */
export function fitScale(
  available: { width: number; height: number },
  content: { width: number; height: number },
  min = 0.4,
): number {
  if (content.width <= 0 || content.height <= 0 || available.width <= 0 || available.height <= 0) {
    return 1;
  }
  const s = Math.min(1, available.width / content.width, available.height / content.height);
  return Math.max(min, s);
}

/** The most places a TV leaderboard lists (it cannot scroll); the rest are "and N more". */
export const LEADERBOARD_TV_MAX = 8;

/**
 * A revealed round with this many answers or more cannot be read on one TV screen, so the TV
 * shows one category at a time and turns the page itself.
 */
export function needsResultsPaging(answerCount: number): boolean {
  return answerCount > 18;
}

/** The page after `page` out of `count`, wrapping to the first. */
export function nextPage(page: number, count: number): number {
  return count <= 1 ? 0 : (page + 1) % count;
}
