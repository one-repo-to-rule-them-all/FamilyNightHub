/**
 * The Gratitude Jar's cycle arithmetic (ADR-0018 amendment, part B): which note is on show.
 * The twin of `jar.cycle_index` in `backend/app/domain/games/jar.py`; both are tested against
 * `jar-cycle.vectors.json`. Times are seconds on any common clock. Pure, React-free.
 */

export function cycleIndex(
  now: number,
  anchorAt: number,
  dwellSeconds: number,
  count: number,
  pausedIndex: number | null,
): number {
  if (count <= 0) return 0;
  if (pausedIndex !== null) return Math.min(pausedIndex, count - 1);
  const elapsed = Math.max(0, now - anchorAt);
  return Math.floor(elapsed / dwellSeconds) % count;
}

/** "Note 4 of 17" (1-based). */
export function cycleCounter(index: number, count: number): string {
  return count <= 0 ? "" : `Note ${index + 1} of ${count}`;
}
