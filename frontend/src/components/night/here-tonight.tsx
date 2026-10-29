"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";

import { Avatar } from "@/components/night/avatar";
import { nightKey } from "@/hooks/use-live-session";
import { api, type Night, type PersonTile } from "@/lib/api";
import {
  fitAvatars,
  HERE_STRIP_COMPACT_STEPS,
  HERE_STRIP_STEPS,
  type PhoneAvatarSize,
} from "@/lib/avatar-fit";
import { hereCount, hereTonight, showHereStrip } from "@/lib/here-tonight";
import { type LiveState, pollWhileDown } from "@/lib/live";
import { cn } from "@/lib/utils";

const presentKey = (sessionId: string) => [...nightKey(sessionId), "present"] as const;

/** Per avatar size: the wrapped strip's cell, and the compact stack's overlap. */
const STRIP: Record<
  PhoneAvatarSize,
  {
    width: string;
    gap: string;
    stack: string;
    name: string;
    chip: string;
    badge: string;
    check: string;
  }
> = {
  lg: {
    width: "w-14",
    gap: "gap-3",
    stack: "-space-x-3",
    name: "text-xs",
    chip: "size-12",
    badge: "size-5",
    check: "size-3",
  },
  md: {
    width: "w-12",
    gap: "gap-2.5",
    stack: "-space-x-2.5",
    name: "text-xs",
    chip: "size-10",
    badge: "size-4.5",
    check: "size-3",
  },
  sm: {
    width: "w-10",
    gap: "gap-2",
    stack: "-space-x-2",
    name: "text-[10px]",
    chip: "size-8",
    badge: "size-4",
    check: "size-2.5",
  },
  xs: {
    width: "w-8",
    gap: "gap-1.5",
    stack: "-space-x-1.5",
    name: "text-[10px]",
    chip: "size-6 text-[10px]",
    badge: "size-3.5",
    check: "size-2",
  },
};

/**
 * "Here tonight" (guest-flow spec §5): avatars of who is here, live, with a ✓ for who voted while
 * voting is open. Never how anyone voted. Keyed under the night, so every stream event refreshes
 * it; it polls only while the stream is down. Until the backend serves `/present` (G8) it shows
 * voters only, labelled "Voted so far". Not a control: no button roles, no press states.
 */
export function HereTonight({
  night,
  live,
  people,
  selfId,
  compact = false,
}: {
  night: Night;
  live: LiveState;
  people: PersonTile[];
  selfId: string | null;
  compact?: boolean;
}) {
  const present = useQuery({
    queryKey: presentKey(night.id),
    queryFn: async () => (await api.present(night.id)).present,
    refetchInterval: pollWhileDown(live),
  });

  if (!present.isSuccess) return null;
  const items = hereTonight(present.data, people);
  if (!showHereStrip(items, selfId)) return null;
  const count = hereCount(items, night.status);
  const voting = night.status === "voting";
  // A crowd steps the avatars down, then wraps (or, compact, overlaps more), then folds into +N.
  const fit = fitAvatars(items.length, compact ? HERE_STRIP_COMPACT_STEPS : HERE_STRIP_STEPS);
  const s = STRIP[fit.size];

  return (
    <section className={cn("flex flex-col gap-2", compact && "flex-row items-center gap-3")}>
      <ul
        aria-label="Here tonight"
        className={cn("flex flex-wrap", compact ? cn("shrink-0 flex-nowrap", s.stack) : s.gap)}
        data-testid="here-tonight"
        data-size={fit.size}
      >
        {items.slice(0, fit.shown).map((item) => (
          <li
            key={item.personId}
            className={cn("flex flex-col items-center gap-1", compact ? "shrink-0" : s.width)}
          >
            <span className="relative">
              <Avatar
                emoji={item.avatarEmoji}
                color={item.color}
                size={fit.size}
                className={cn(compact && "ring-2 ring-background")}
              />
              {voting && item.voted ? (
                <span
                  className={cn(
                    "absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-foreground text-background",
                    s.badge,
                  )}
                >
                  <Check aria-hidden className={s.check} />
                  <span className="sr-only">voted</span>
                </span>
              ) : null}
            </span>
            {compact ? (
              <span className="sr-only">{item.name ?? "Guest"}</span>
            ) : (
              <span className={cn("w-full truncate text-center", s.name)}>
                {item.name ?? "Guest"}
              </span>
            )}
          </li>
        ))}
        {fit.more > 0 ? (
          <li
            className={cn("flex flex-col items-center", compact ? "shrink-0" : s.width)}
            data-testid="here-tonight-more"
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground tabular-nums",
                s.chip,
                compact && "ring-2 ring-background",
              )}
            >
              +{fit.more}
              <span className="sr-only"> more</span>
            </span>
          </li>
        ) : null}
      </ul>
      <p className="text-sm text-muted-foreground">
        {compact ? null : <span className="font-medium text-foreground">Here tonight · </span>}
        <span aria-live="polite">{count}</span>
      </p>
    </section>
  );
}
