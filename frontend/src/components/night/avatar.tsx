import type { PhoneAvatarSize } from "@/lib/avatar-fit";
import { cn } from "@/lib/utils";

/** Phone sizes for `size` (lib/avatar-fit.ts picks one from the head count). */
const SIZES: Record<PhoneAvatarSize, string> = {
  lg: "size-12 text-2xl",
  md: "size-10 text-xl",
  sm: "size-8 text-lg",
  xs: "size-6 text-sm",
};

/** The emoji-on-colour avatar used on the /who grid, reused by the host and TV screens. */
export function Avatar({
  emoji,
  color,
  size,
  className,
}: {
  emoji: string;
  color: string;
  /** Optional preset; `className` still wins, so existing callers are unchanged. */
  size?: PhoneAvatarSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-full",
        size && ["shrink-0", SIZES[size]],
        className,
      )}
      style={{ backgroundColor: `color-mix(in oklch, ${color} 45%, transparent)` }}
    >
      {emoji}
    </span>
  );
}
