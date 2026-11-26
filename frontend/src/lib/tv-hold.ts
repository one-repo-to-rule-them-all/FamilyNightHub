/**
 * The TV holds a finished game's result screen (ADR-0018 amendment 2026-11-26, win and lose
 * moment): when a game the host sent to the TV ends, the TV stays on its winner banner and results
 * for `TV_HOLD_MS`, then follows its usual order. "Back to QR" or "Show on TV" for another game
 * moves it sooner (the server forgets the ended target, so `ended_game_id` goes null).
 */
export const TV_HOLD_MS = 120_000;

export interface EndedTarget {
  ended_game_id?: string | null;
  ended_at?: string | null;
  server_now?: string | null;
}

/** How long ago the game ended by the server's clock (skew-free), or null without the data. */
export function serverElapsedMs(target: EndedTarget): number | null {
  if (!target.ended_at || !target.server_now) return null;
  const ms = Date.parse(target.server_now) - Date.parse(target.ended_at);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/**
 * How long the hold has run: the longer of the server's "ended this long ago" (a TV that arrives
 * late does not hold again) and the time since this TV first saw it ended (its own clock, so the
 * hold ends even when every poll's server answer is the same).
 */
export function holdElapsedMs(
  target: EndedTarget,
  observedAtMs: number | null,
  nowMs: number,
): number {
  const server = serverElapsedMs(target) ?? 0;
  const local = observedAtMs === null ? 0 : Math.max(0, nowMs - observedAtMs);
  return Math.max(server, local);
}

/** Should the TV leave this game's screen yet? */
export function shouldLeaveTv(
  gameId: string,
  target: EndedTarget & { game_id: string | null },
  observedAtMs: number | null,
  nowMs: number,
  holdMs = TV_HOLD_MS,
): boolean {
  if (target.game_id === gameId) return false; // still the live target
  if (target.game_id) return true; // the host sent another game
  if (target.ended_game_id !== gameId) return true; // Back to QR (or never sent)
  return holdElapsedMs(target, observedAtMs, nowMs) >= holdMs;
}

/** Ms left in the hold (0 when over). */
export function holdRemainingMs(
  target: EndedTarget,
  observedAtMs: number | null,
  nowMs: number,
  holdMs = TV_HOLD_MS,
): number {
  return Math.max(0, holdMs - holdElapsedMs(target, observedAtMs, nowMs));
}

/**
 * Should /tv go back to an ended target? Only while the server says the hold is still on and this
 * TV has not already left it (a released game is never re-entered).
 */
export function shouldReturnToEnded(
  target: EndedTarget,
  released: ReadonlySet<string>,
  holdMs = TV_HOLD_MS,
): boolean {
  if (!target.ended_game_id || released.has(target.ended_game_id)) return false;
  const elapsed = serverElapsedMs(target);
  return elapsed !== null && elapsed < holdMs;
}

/** Games this TV already left after their hold (for this page's lifetime). */
export const releasedGames = new Set<string>();
