/**
 * Scattergories logic (ADR-0018 slice C), React-free so it is unit-tested. The server is the
 * clock: it stores `ends_at` and sends `server_now` with every snapshot; a client derives its own
 * offset once per snapshot and counts down locally, so no tick ever crosses the wire.
 */

/** Matches the backend's limits (services/scatter_service.py). */
export const ANSWER_MAX = 60;
export const CATEGORY_MAX = 12;
export const DURATIONS = [60, 90, 120, 180] as const;
export const DEFAULT_DURATION = 120;

export type RoundState = "lobby" | "running" | "closed" | "revealed";

/** Server time minus the device's time at the moment the snapshot arrived. */
export function clockOffsetMs(serverNowIso: string, receivedAtMs: number): number {
  return Date.parse(serverNowIso) - receivedAtMs;
}

/** Whole seconds left on the round's clock, never negative, rounded up so 0 means over. */
export function secondsLeft(endsAtIso: string, offsetMs: number, nowMs: number): number {
  const ms = Date.parse(endsAtIso) - (nowMs + offsetMs);
  return Math.max(0, Math.ceil(ms / 1000));
}

/** `1:05`, or `0:09`. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Share of the round still to run, 0..1, for the progress bar. */
export function timeFraction(seconds: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, seconds / durationSeconds));
}

/** Can answers still be typed? The server allows a 2 s grace past this; the UI does not. */
export function canAnswer(state: RoundState, seconds: number): boolean {
  return state === "running" && seconds > 0;
}

/** The text-area form of a category list: one per line. */
export function categoriesToText(categories: readonly string[]): string {
  return categories.join("\n");
}

/** One category per line: trimmed, blanks and case-insensitive repeats dropped, capped at 12. */
export function parseCategories(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const clean = line.trim().replace(/\s+/g, " ");
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.slice(0, CATEGORY_MAX);
}

/** Can the host start a round with this list? */
export function canStartRound(categories: readonly string[]): boolean {
  return categories.length >= 1 && categories.length <= CATEGORY_MAX;
}

/** The draft as the PUT body: every category, a blank clearing it. */
export function answerBody(draft: readonly string[]): { category_index: number; text: string }[] {
  return draft.map((text, category_index) => ({ category_index, text: text.trim() }));
}

/** Start the draft from what the server already has (a reload mid-round). */
export function draftFrom(
  categoryCount: number,
  saved: readonly { category_index: number; text: string }[],
): string[] {
  const draft = Array.from({ length: categoryCount }, () => "");
  for (const a of saved) if (a.category_index < categoryCount) draft[a.category_index] = a.text;
  return draft;
}

/** Has the draft changed since the server last confirmed it? */
export function isDirty(draft: readonly string[], saved: readonly string[]): boolean {
  return (
    draft.length !== saved.length || draft.some((t, i) => t.trim() !== (saved[i] as string).trim())
  );
}

/** "3 of 6 answered". */
export function answeredLine(answered: number, total: number): string {
  return `${answered} of ${total} answered`;
}

/** The round's heading: "Round 2 · letter P". */
export function roundHeading(roundNo: number, letter: string): string {
  return `Round ${roundNo} · letter ${letter}`;
}

export function stateLabel(state: RoundState, secondsRemaining: number): string {
  if (state === "lobby") return "Waiting for the host";
  if (state === "revealed") return "Answers revealed";
  if (state === "closed" || secondsRemaining <= 0) return "Time is up";
  return "Go!";
}

/** Revealed answers grouped by category index, in category order. */
export function byCategory<T extends { category_index: number }>(
  categories: readonly string[],
  answers: readonly T[],
): { category: string; answers: T[] }[] {
  return categories.map((category, index) => ({
    category,
    answers: answers.filter((a) => a.category_index === index),
  }));
}

/** Why an answer scored nothing, for the results list. Empty when it scored. */
export function answerNote(a: {
  valid: boolean;
  point: number;
  verdict: "accepted" | "rejected" | null;
}): string {
  if (a.verdict === "rejected") return "Host rejected";
  if (!a.valid) return "Wrong letter";
  if (a.point === 0) return "Someone else had it";
  return "";
}

/** The verdict a button sets: rejecting a rejected answer would be a no-op, so it re-accepts. */
export function nextVerdict(current: "accepted" | "rejected" | null): "accepted" | "rejected" {
  return current === "rejected" ? "accepted" : "rejected";
}

/** Points, with the unit. */
export function pointsLabel(points: number): string {
  return `${points} ${points === 1 ? "pt" : "pts"}`;
}
