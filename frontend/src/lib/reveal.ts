/**
 * The TV's reveal spinner (ADR-0006): purely cosmetic. The winner is already stored on the
 * session (`result.winner_option_id`); the spinner walks the shortlist a few laps, slowing down,
 * and always stops on that stored winner. No randomness, so every screen and every replay agrees.
 */

export type RevealFrame = { optionId: string; delayMs: number };

export type RevealOptions = {
  /** Full laps over the shortlist before the final approach. */
  laps?: number;
  /** Delay of the first (fastest) step and the last (slowest) one. */
  fastMs?: number;
  slowMs?: number;
  /** prefers-reduced-motion: no spin, just the winner. */
  reducedMotion?: boolean;
};

/**
 * Frames to show in order; each is visible for its `delayMs` before the next. The last frame is
 * always the winner, with delay 0 (it stays). An unknown winner or an empty shortlist gives no
 * frames, and the caller shows the stored result as-is.
 */
export function revealSequence(
  optionIds: string[],
  winnerId: string,
  { laps = 2, fastMs = 70, slowMs = 520, reducedMotion = false }: RevealOptions = {},
): RevealFrame[] {
  const winnerIndex = optionIds.indexOf(winnerId);
  if (winnerIndex === -1) return [];
  if (reducedMotion || optionIds.length === 1) return [{ optionId: winnerId, delayMs: 0 }];

  const steps = laps * optionIds.length + winnerIndex + 1;
  const frames: RevealFrame[] = [];
  for (let i = 0; i < steps; i++) {
    const last = i === steps - 1;
    // Ease-out: quadratic slow-down towards the end, like a wheel losing speed.
    const t = steps === 1 ? 1 : i / (steps - 1);
    frames.push({
      optionId: optionIds[i % optionIds.length],
      delayMs: last ? 0 : Math.round(fastMs + (slowMs - fastMs) * t * t),
    });
  }
  return frames;
}

/** Total spin time, for tests and for pacing anything that waits on the reveal. */
export function revealDuration(frames: RevealFrame[]): number {
  return frames.reduce((sum, f) => sum + f.delayMs, 0);
}
