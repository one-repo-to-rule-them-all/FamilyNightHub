/**
 * How many avatars fit, and how big (issue #90): as the crowd grows, avatars step down in size,
 * then wrap, then the rest collapse into a "+N". Pure so every screen picks the same way.
 */

/** One size step: used while the count is at most `upTo`. Steps are ordered by `upTo`. */
export type FitStep<S> = { upTo: number; size: S };

export type AvatarFit<S> = {
  size: S;
  /** Avatars to draw. */
  shown: number;
  /** People folded into the "+N"; 0 when everyone fits. */
  more: number;
};

/**
 * The first step big enough for `count` wins. Past the last step its size holds and the extra
 * people fold into a "+N" that takes one of its slots, so the total never exceeds that step.
 */
export function fitAvatars<S>(count: number, steps: readonly FitStep<S>[]): AvatarFit<S> {
  if (steps.length === 0) throw new Error("fitAvatars needs at least one step");
  const n = Math.max(0, Math.floor(count));
  const step = steps.find((s) => n <= s.upTo);
  if (step) return { size: step.size, shown: n, more: 0 };
  const last = steps[steps.length - 1];
  const shown = Math.max(0, last.upTo - 1);
  return { size: last.size, shown, more: n - shown };
}

/**
 * The TV's turnout tiles. Each size also fixes the column count, so the grid's height is known
 * and it fits the lobby's right column at 16:9 (the TV sizes everything in em, tv.css).
 */
export type TvTileSize = "xl" | "lg" | "md" | "sm";
export const TV_TURNOUT_STEPS: readonly FitStep<TvTileSize>[] = [
  { upTo: 6, size: "xl" }, // 3 × 2
  { upTo: 12, size: "lg" }, // 4 × 3
  { upTo: 20, size: "md" }, // 5 × 4
  { upTo: 30, size: "sm" }, // 6 × 5
];

/** The phone's Here tonight strip: wraps in rows. */
export type PhoneAvatarSize = "lg" | "md" | "sm" | "xs";
export const HERE_STRIP_STEPS: readonly FitStep<PhoneAvatarSize>[] = [
  { upTo: 6, size: "lg" },
  { upTo: 12, size: "md" },
  { upTo: 20, size: "sm" },
];

/** The compact strip: one overlapping row beside the count, so it stays short. */
export const HERE_STRIP_COMPACT_STEPS: readonly FitStep<PhoneAvatarSize>[] = [
  { upTo: 5, size: "sm" },
  { upTo: 8, size: "xs" },
];
