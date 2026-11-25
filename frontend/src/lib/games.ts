/**
 * Games tab logic (ADR-0018): copy and small rules shared by the phone, host and TV screens.
 * React-free so it is unit-tested.
 */

export type GameKind = "gratitude_jar" | "bingo" | "scattergories" | "loteria";
export type GameStatus = "draft" | "open" | "live" | "ended";

/** The server's note limit (domain/games/jar.py). */
export const NOTE_MAX = 280;

export const KIND_COPY: Record<GameKind, { name: string; blurb: string }> = {
  gratitude_jar: {
    name: "Gratitude jar",
    blurb: "Drop in what you are thankful for. Once the host starts it, the notes cycle on the TV.",
  },
  bingo: {
    name: "Thanksgiving bingo",
    blurb: "Tap squares as things happen at the table. First line wins.",
  },
  scattergories: {
    name: "Scattergories",
    blurb: "One letter, a list of categories, beat the clock.",
  },
  loteria: {
    name: "Lotería",
    blurb: "The host calls a picture, you mark it on your tabla. Shout ¡Lotería! to win.",
  },
};

/** Every kind is playable. */
export const PLAYABLE: readonly GameKind[] = ["gratitude_jar", "bingo", "scattergories", "loteria"];

/** The name to show for a game: bingo says which kind (classic or Thanksgiving). */
export function kindName(kind: GameKind, mode?: "thanksgiving" | "classic" | null): string {
  if (kind === "bingo" && mode === "classic") return "Classic bingo";
  return KIND_COPY[kind].name;
}

export function statusLabel(kind: GameKind, status: GameStatus): string {
  if (kind === "gratitude_jar") {
    if (status === "open") return "Collecting notes";
    if (status === "live") return "Revealing";
    return "Finished";
  }
  if (status === "ended") return "Finished";
  if (status === "draft") return "Setting up";
  if (kind === "scattergories") return status === "live" ? "Playing" : "Waiting to start";
  if (kind === "loteria") return status === "live" ? "Playing" : "Open";
  return status === "live" ? "Live" : "Open";
}

const length = (body: string) => [...body.trim()].length;

/** The note box's counter, e.g. "52 / 280". */
export function noteCounter(body: string): { text: string; over: boolean } {
  const n = length(body);
  return { text: `${n} / ${NOTE_MAX}`, over: n > NOTE_MAX };
}

/** Can this body be sent? */
export function canSendNote(body: string): boolean {
  const n = length(body);
  return n > 0 && n <= NOTE_MAX;
}

export function jarProgress(noteCount: number, revealedCount: number): string {
  if (noteCount === 0) return "No notes yet";
  if (revealedCount === 0) return `${noteCount} ${noteCount === 1 ? "note" : "notes"} in the jar`;
  return `${revealedCount} of ${noteCount} revealed`;
}

/** The jar's progress line. A cycling jar that has started has no "revealed" count to show. */
export function jarStatusLine(
  jar: { mode?: string; cycle?: unknown; note_count: number; revealed_count: number },
  position: { index: number; count: number } | null,
): string {
  if (jar.mode === "cycle" && jar.cycle && position && position.count > 0) {
    return `${position.count} ${position.count === 1 ? "note" : "notes"} cycling`;
  }
  return jarProgress(jar.note_count, jar.revealed_count);
}

/** Who wrote a revealed note, as a caption. An anonymous note has no author. */
export function authorLine(author: { name: string } | null): string {
  return author ? `— ${author.name}` : "— Someone in the family";
}
