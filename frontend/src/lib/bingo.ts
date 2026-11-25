/**
 * Thanksgiving bingo logic (ADR-0018 slice B): labels and ordering shared by the phone, host and
 * TV screens. React-free so it is unit-tested. The server decides wins; nothing here does.
 */

export type WinMode = "line" | "blackout";

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
