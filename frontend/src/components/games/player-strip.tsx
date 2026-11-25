import { Check } from "lucide-react";

import { Avatar } from "@/components/night/avatar";
import {
  playerCountLabel,
  stripDensity,
  stripMaxRows,
  stripNameMaxEm,
  type StripPlayer,
  type StripVariant,
} from "@/lib/game-layout";
import { cn } from "@/lib/utils";

/** Type scale per variant and density; the TV's is in `em` off the `.tv-screen` root. */
const TEXT: Record<StripVariant, Record<"roomy" | "compact" | "dense", string>> = {
  tv: { roomy: "text-[1.5em]", compact: "text-[1.05em]", dense: "text-[0.9em]" },
  phone: { roomy: "text-base", compact: "text-base", dense: "text-sm" },
  host: { roomy: "text-base", compact: "text-base", dense: "text-sm" },
};

/**
 * The footer strip every game screen ends with: avatar, name and a per-game status chip for each
 * player. Never clipped: TV and host wrap onto a few rows and then scroll inside the strip; the
 * phone scrolls sideways in one row. Winners carry the cinema accent and a check, never colour
 * alone.
 *
 * `itemTestId` keeps a game's existing per-player test id (`tv-bingo-player`, ...).
 */
export function PlayerStrip({
  players,
  variant,
  itemTestId,
  emptyText = "No players yet",
  className,
}: {
  players: readonly StripPlayer[];
  variant: StripVariant;
  itemTestId?: string;
  emptyText?: string;
  className?: string;
}) {
  const density = stripDensity(players.length);
  const rows = stripMaxRows(variant, density);
  const tv = variant === "tv";
  const phone = variant === "phone";

  return (
    <section
      aria-label={`Players, ${playerCountLabel(players.length)}`}
      data-testid="player-strip"
      data-variant={variant}
      data-density={density}
      data-count={players.length}
      className={cn("w-full min-w-0", className)}
    >
      {players.length === 0 ? (
        <p className={cn("text-muted-foreground", tv ? "tv-small text-center" : "text-sm")}>
          {emptyText}
        </p>
      ) : (
        <ul
          tabIndex={0}
          aria-label="Players"
          className={cn(
            "flex gap-[0.6em] rounded-[0.5em] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            TEXT[variant][density],
            phone
              ? "snap-x snap-mandatory overflow-x-auto overflow-y-hidden pb-1"
              : "flex-wrap overflow-x-hidden overflow-y-auto",
            tv && "justify-center",
          )}
          style={phone ? undefined : { maxHeight: `calc(${rows} * 3.6em + ${rows - 1} * 0.6em)` }}
        >
          {players.map((p) => (
            <li
              key={p.id}
              data-testid={itemTestId}
              data-won={p.highlight ? "true" : "false"}
              className={cn(
                "flex min-w-0 items-center gap-[0.6em] rounded-[0.9em] border bg-card px-[0.7em] py-[0.35em] text-left",
                phone ? "min-h-14 shrink-0 snap-start" : "min-h-[3em]",
                p.highlight ? "border-[var(--accent-cinema)]" : "border-foreground/10",
              )}
            >
              <Avatar
                emoji={p.emoji}
                color={p.color}
                className="size-[2em] shrink-0 text-[1.1em]"
              />
              <span
                className="min-w-0 leading-tight"
                style={phone ? undefined : { maxWidth: `${stripNameMaxEm(density)}em` }}
              >
                <span className="block truncate font-medium">{p.name}</span>
                {p.chip ? (
                  <span className="flex items-center gap-[0.3em] text-[0.85em] text-muted-foreground">
                    {p.highlight ? <Check aria-hidden className="size-[1em]" /> : null}
                    {p.chip}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
