/**
 * Thanksgiving bingo logic (ADR-0018 slice B): labels and ordering shared by the phone, host and
 * TV screens. React-free so it is unit-tested. The server decides wins; nothing here does.
 */

export type WinMode = "line" | "blackout" | "corners" | "x" | "stamp";

export interface BingoPlayerLike {
  person_id: string;
  name: string;
  squares_from_bingo: number;
  won: boolean;
  finish_place: number | null;
}

export const CARD_SIZE = 5;
export const FREE_LABEL = "FREE";

export const WIN_MODE_COPY: Record<WinMode, { name: string; blurb: string }> = {
  line: { name: "Line", blurb: "Any row, column or diagonal wins." },
  blackout: { name: "Blackout", blurb: "Every square on the card." },
  corners: { name: "Four corners", blurb: "The four corner squares." },
  x: { name: "The X", blurb: "Both diagonals, corner to corner." },
  stamp: { name: "Postage stamp", blurb: "A 2×2 block in any corner of the card." },
};

/** A player's distance from winning, as a short caption: "Bingo!", "1 away", "4 to go". */
export function progressLabel(player: Pick<BingoPlayerLike, "squares_from_bingo" | "won">): string {
  if (player.won || player.squares_from_bingo === 0) return "Bingo!";
  if (player.squares_from_bingo === 1) return "1 away";
  return `${player.squares_from_bingo} to go`;
}

/** Winners by finishing place, then everyone by how close they are, then by name. */
export function rankPlayers<T extends BingoPlayerLike>(players: readonly T[]): T[] {
  return [...players].sort((a, b) => {
    if (a.won !== b.won) return a.won ? -1 : 1;
    if (a.won && b.won) return (a.finish_place ?? 0) - (b.finish_place ?? 0);
    return a.squares_from_bingo - b.squares_from_bingo || a.name.localeCompare(b.name);
  });
}

/** Names of everyone who has won so far, in finishing order. */
export function winnerNames(players: readonly BingoPlayerLike[]): string[] {
  return rankPlayers(players)
    .filter((p) => p.won)
    .map((p) => p.name);
}

/** "Sam got bingo!" / "Sam and Kim got bingo!" / "A, B and C got bingo!" */
export function winnerLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} got bingo!`;
}

/** The marked squares as a set for O(1) lookups when rendering the grid. */
export function markedSet(marked: readonly number[]): ReadonlySet<number> {
  return new Set(marked);
}

/** Screen-reader label for one square: "Row 2, column 3: Turkey, marked". */
export function squareLabel(square: string, index: number, isMarked: boolean): string {
  const row = Math.floor(index / CARD_SIZE) + 1;
  const column = (index % CARD_SIZE) + 1;
  const what = square === FREE_LABEL ? "free space" : square;
  return `Row ${row}, column ${column}: ${what}, ${isMarked ? "marked" : "not marked"}`;
}

/** Squares are tappable only while the round is live and the card is not the free centre. */
export function canTapSquare(status: string, square: string): boolean {
  return status === "live" && square !== FREE_LABEL;
}

/** What the phone says under the title for each state of the round. */
export function bingoStatusLine(status: string, joined: boolean): string {
  if (status === "draft") return "The host is getting ready.";
  if (status === "open") {
    return joined ? "You are in. Waiting for the host to start." : "Take a seat to get your card.";
  }
  if (status === "live") return joined ? "Tap each square as it happens." : "The round is on.";
  return "That round is over.";
}

// ---- Classic host-called bingo (ADR-0018 amendment 2026-11-25, part A) ----

export type BingoMode = "thanksgiving" | "classic";
export const MODE_COPY: Record<BingoMode, { name: string; blurb: string }> = {
  classic: { name: "Classic", blurb: "You draw numbers, everyone marks them, you check a bingo." },
  thanksgiving: {
    name: "Thanksgiving",
    blurb: "Tap squares as things happen at the table. First line wins.",
  },
};
export const BINGO_LETTERS = ["B", "I", "N", "G", "O"] as const;
export const NUMBERS_PER_COLUMN = 15;
/** How many recent calls the phone and the TV list under the last call. */
export const RECENT_CALLS = 5;

export interface CallLike {
  seq: number;
  value: number;
  label: string;
}

/** "B 7": the letter and number apart so the TV can set them big. */
export function spacedLabel(call: Pick<CallLike, "label">): string {
  return call.label.replace(/^([BINGO])/, "$1 ");
}

const CARD_LINES: readonly (readonly number[])[] = [
  ...Array.from({ length: CARD_SIZE }, (_, r) =>
    Array.from({ length: CARD_SIZE }, (_, c) => r * CARD_SIZE + c),
  ),
  ...Array.from({ length: CARD_SIZE }, (_, c) =>
    Array.from({ length: CARD_SIZE }, (_, r) => r * CARD_SIZE + c),
  ),
  Array.from({ length: CARD_SIZE }, (_, i) => i * CARD_SIZE + i),
  Array.from({ length: CARD_SIZE }, (_, i) => i * CARD_SIZE + (CARD_SIZE - 1 - i)),
];

const LAST = CARD_SIZE - 1;
const CORNER_SQUARES = [0, LAST, LAST * CARD_SIZE, LAST * CARD_SIZE + LAST];
const X_SQUARES = [...new Set([...CARD_LINES[CARD_SIZE * 2], ...CARD_LINES[CARD_SIZE * 2 + 1]])];
const STAMP_BLOCKS: readonly (readonly number[])[] = [0, CARD_SIZE - 2].flatMap((r) =>
  [0, CARD_SIZE - 2].map((c) =>
    [0, 1].flatMap((dr) => [0, 1].map((dc) => (r + dr) * CARD_SIZE + c + dc)),
  ),
);

/** Every winning pattern for a mode (any one wins). Mirrors the server's `bingo.patterns`. */
export function winPatterns(winMode: WinMode): readonly (readonly number[])[] {
  switch (winMode) {
    case "blackout":
      return [Array.from({ length: CARD_SIZE * CARD_SIZE }, (_, i) => i)];
    case "corners":
      return [CORNER_SQUARES];
    case "x":
      return [X_SQUARES];
    case "stamp":
      return STAMP_BLOCKS;
    default:
      return CARD_LINES;
  }
}

/**
 * How many squares a player still has to MARK to complete a pattern. A classic round's server
 * count follows the host's called numbers; the player's own count should follow their taps, or
 * tapping looks like it does nothing. (The free centre is in `marked` when the round has one.)
 */
export function markedToGo(marked: readonly number[], winMode: WinMode): number {
  const set = new Set(marked);
  return Math.min(...winPatterns(winMode).map((p) => p.filter((i) => !set.has(i)).length));
}

/** A call split for display: "N34" is the letter "N" and the number "34". */
export function callParts(call: Pick<CallLike, "label">): { letter: string; number: string } {
  const match = /^([BINGO])(\d+)$/.exec(call.label);
  return match ? { letter: match[1], number: match[2] } : { letter: "", number: call.label };
}

/** The called numbers as a set for O(1) lookups. */
export function calledSet(calls: readonly Pick<CallLike, "value">[]): ReadonlySet<number> {
  return new Set(calls.map((c) => c.value));
}

/** The board's five rows (B, I, N, G, O), each holding that letter's 15 numbers. */
export function boardRows(): { letter: string; values: number[] }[] {
  return BINGO_LETTERS.map((letter, row) => ({
    letter,
    values: Array.from({ length: NUMBERS_PER_COLUMN }, (_, i) => row * NUMBERS_PER_COLUMN + i + 1),
  }));
}

/** The calls before the last one (which has its own big display), newest first, at most `n`. */
export function recentCalls<T extends CallLike>(calls: readonly T[], n = RECENT_CALLS): T[] {
  return calls.slice(-(n + 1), -1).reverse();
}

/** Is this card square a number that has been called (the free centre always is)? */
export function squareIsCalled(square: string, called: ReadonlySet<number>): boolean {
  return square === FREE_LABEL || called.has(Number(square));
}

/** A square the phone can mark: the round is live and the number was called (or is free). */
export function canMarkClassic(
  status: string,
  square: string,
  called: ReadonlySet<number>,
): boolean {
  return status === "live" && square !== FREE_LABEL && squareIsCalled(square, called);
}

/** Why a tap on an uncalled square did nothing. */
export function notCalledMessage(square: string): string {
  return `${square} hasn't been called yet.`;
}

/** Screen-reader label for one classic square. */
export function classicSquareLabel(
  square: string,
  index: number,
  isMarked: boolean,
  isCalled: boolean,
): string {
  const base = squareLabel(square, index, isMarked);
  return square === FREE_LABEL || isCalled ? base : `${base}, not called yet`;
}

/** What the phone says under the title in a classic round. */
export function classicStatusLine(status: string, joined: boolean, calls: number): string {
  if (status === "live") {
    if (!joined) return "The round is on.";
    return calls === 0 ? "Waiting for the first number." : "Tap each number the host calls.";
  }
  return bingoStatusLine(status, joined);
}

export interface CheckResultLike {
  valid: boolean;
  win_mode: WinMode;
  pattern: number[] | null;
  missing: number;
}

const ROW_NAMES = ["top row", "second row", "middle row", "fourth row", "bottom row"];
const COL_NAMES = ["B column", "I column", "N column", "G column", "O column"];

/** Name the winning pattern for the host to read out: "top row", "B column", "diagonal". */
export function patternName(pattern: readonly number[] | null): string {
  if (!pattern) return "";
  if (pattern.length === CARD_SIZE * CARD_SIZE) return "the whole card";
  const key = [...pattern].sort((a, b) => a - b).join(",");
  if (key === [...CORNER_SQUARES].sort((a, b) => a - b).join(",")) return "four corners";
  if (key === [...X_SQUARES].sort((a, b) => a - b).join(",")) return "the X";
  if (STAMP_BLOCKS.some((b) => b.join(",") === key)) return "postage stamp";
  const rows = new Set(pattern.map((i) => Math.floor(i / CARD_SIZE)));
  if (rows.size === 1) return ROW_NAMES[[...rows][0]];
  const cols = new Set(pattern.map((i) => i % CARD_SIZE));
  if (cols.size === 1) return COL_NAMES[[...cols][0]];
  return "diagonal";
}

/** The host's inline answer to Check bingo: a quiet message either way, never an error. */
export function checkResultLine(name: string, result: CheckResultLike): string {
  if (result.valid) return `${name}: valid, ${patternName(result.pattern)}.`;
  return `${name}: not yet, ${result.missing} away.`;
}
