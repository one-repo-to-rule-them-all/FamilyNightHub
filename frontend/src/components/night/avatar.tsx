import { cn } from "@/lib/utils";

/** The emoji-on-colour avatar used on the /who grid, reused by the host and TV screens. */
export function Avatar({
  emoji,
  color,
  className,
}: {
  emoji: string;
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("flex items-center justify-center rounded-full", className)}
      style={{ backgroundColor: `color-mix(in oklch, ${color} 45%, transparent)` }}
    >
      {emoji}
    </span>
  );
}
