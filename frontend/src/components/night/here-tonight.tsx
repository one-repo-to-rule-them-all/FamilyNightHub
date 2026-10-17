"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";

import { Avatar } from "@/components/night/avatar";
import { nightKey } from "@/hooks/use-live-session";
import { useVoters } from "@/hooks/use-voters";
import { api, ApiError, type Night, type PersonTile, type PresentPerson } from "@/lib/api";
import { hereSummary, hereTonight, overflow, showHereStrip } from "@/lib/here-tonight";
import { type LiveState, pollWhileDown } from "@/lib/live";
import { cn } from "@/lib/utils";

const presentKey = (sessionId: string) => [...nightKey(sessionId), "present"] as const;

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
  const present = useQuery<PresentPerson[] | null, ApiError>({
    queryKey: presentKey(night.id),
    queryFn: async () => {
      try {
        return (await api.present(night.id)).present;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    refetchInterval: pollWhileDown(live),
  });
  const fallback = present.isSuccess && present.data === null;
  const voters = useVoters(night.id, fallback, live);

  if (!present.isSuccess) return null;
  const items = hereTonight(present.data, voters.data ?? [], people);
  if (!showHereStrip(items, selfId)) return null;
  const { label, count } = hereSummary(items, night.status, !fallback);
  const voting = night.status === "voting";
  const { shown, more } = overflow(items, compact ? 6 : 10);

  return (
    <section className={cn("flex flex-col gap-2", compact && "flex-row items-center gap-3")}>
      <ul
        aria-label="Here tonight"
        className={cn("flex flex-wrap gap-3", compact && "gap-0 -space-x-2")}
        data-testid="here-tonight"
      >
        {shown.map((item) => (
          <li
            key={item.personId}
            className={cn("flex flex-col items-center gap-1", compact ? "w-8" : "w-14")}
          >
            <span className="relative">
              <Avatar
                emoji={item.avatarEmoji}
                color={item.color}
                className={cn(
                  compact ? "size-8 text-lg ring-2 ring-background" : "size-12 text-2xl",
                )}
              />
              {voting && item.voted ? (
                <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
                  <Check aria-hidden className="size-3" />
                  <span className="sr-only">voted</span>
                </span>
              ) : null}
            </span>
            {compact ? (
              <span className="sr-only">{item.name ?? "Guest"}</span>
            ) : (
              <span className="w-full truncate text-center text-xs">{item.name ?? "Guest"}</span>
            )}
          </li>
        ))}
        {more > 0 ? (
          <li className="flex flex-col items-center text-sm text-muted-foreground">+{more}</li>
        ) : null}
      </ul>
      <p className="text-sm text-muted-foreground">
        {compact ? null : <span className="font-medium text-foreground">{label} · </span>}
        <span aria-live="polite">{count}</span>
      </p>
    </section>
  );
}
