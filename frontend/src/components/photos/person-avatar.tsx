import { cn } from "@/lib/utils";

/** Emoji on the person's colour (the /who tile look). Decorative: callers name the person. */
export function PersonAvatar({
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
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full text-2xl",
        className,
      )}
      style={{ backgroundColor: `color-mix(in oklch, ${color} 45%, transparent)` }}
    >
      {emoji}
    </span>
  );
}
