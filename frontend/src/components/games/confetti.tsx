"use client";

import { usePrefersReducedMotion } from "@/hooks/use-media";

const COLORS = ["var(--accent-cinema)", "#facc15", "#38bdf8", "#4ade80", "#f472b6", "#fb923c"];
const PIECES = 36;

/**
 * A short CSS confetti burst (win and lose moment, ADR-0018 amendment 2026-11-26). No dependency,
 * no canvas: a few dozen absolutely positioned pieces falling once. Decorative (`aria-hidden`,
 * no pointer events). Under prefers-reduced-motion it renders nothing at all.
 */
export function Confetti({
  testId = "confetti",
  fixed = false,
}: {
  testId?: string;
  fixed?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;
  return (
    <div
      aria-hidden
      data-testid={testId}
      className={`pointer-events-none ${fixed ? "fixed z-40" : "absolute"} inset-0 overflow-hidden`}
    >
      {Array.from({ length: PIECES }, (_, i) => {
        // Deterministic spread (no Math.random, so server and client agree).
        const left = (i * 37) % 100;
        const delay = (i % 9) * 0.12;
        const duration = 2.2 + ((i * 7) % 10) / 10;
        const size = 6 + (i % 4) * 2;
        return (
          <span
            key={i}
            className="confetti-piece"
            style={{
              left: `${left}%`,
              width: size,
              height: size * 1.6,
              backgroundColor: COLORS[i % COLORS.length],
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
              borderRadius: i % 3 === 0 ? "9999px" : "2px",
            }}
          />
        );
      })}
    </div>
  );
}
