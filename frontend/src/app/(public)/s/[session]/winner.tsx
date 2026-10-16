import { Trophy } from "lucide-react";

import { Poster } from "@/components/poster";
import type { Night } from "@/lib/api";
import { cn } from "@/lib/utils";

const TIEBREAK_NOTE: Record<NonNullable<Night["result"]>["tiebreak"], string | null> = {
  none: null,
  first_places: "Tied on points; it had the most first picks.",
  head_to_head: "Tied on points; it won head to head.",
  random: "Tied all the way; a random draw picked it.",
};

/**
 * The winner from the stored result (ADR-0006: every screen shows the same winner because the
 * server decided it). The accent colour is used here and nowhere else on the screen.
 */
export function WinnerCard({ night, compact = false }: { night: Night; compact?: boolean }) {
  const result = night.result;
  const winner = result ? night.options.find((o) => o.id === result.winner_option_id) : undefined;
  if (!result || !winner) {
    return <p className="text-lg text-muted-foreground">No winner was picked for this night.</p>;
  }
  const note = TIEBREAK_NOTE[result.tiebreak];
  return (
    <section
      aria-labelledby="winner-title"
      data-testid="winner-card"
      className={cn(
        "flex gap-4 rounded-2xl bg-cinema-muted p-4 marquee-glow",
        compact ? "flex-row items-center" : "flex-col items-center text-center",
      )}
    >
      <Poster
        title={winner.title}
        posterPath={winner.poster_path}
        className={compact ? "w-24 shrink-0" : "w-56"}
      />
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-sm font-medium tracking-wide text-cinema uppercase">
          <Trophy aria-hidden className="size-4" />
          Tonight&apos;s movie
        </p>
        <h2
          id="winner-title"
          data-testid="winner-title"
          className="font-heading text-3xl font-semibold tracking-tight"
        >
          {winner.title}
        </h2>
        {winner.year ? <p className="text-muted-foreground">{winner.year}</p> : null}
        {note && !compact ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}

/** The rest of the ranking, plain (no accent): place, title, points. */
export function Results({ night }: { night: Night }) {
  const result = night.result;
  if (!result) return null;
  const titles = new Map(night.options.map((o) => [o.id, o.title]));
  const others = result.placements.filter((p) => p.option_id !== result.winner_option_id);
  return (
    <section aria-labelledby="results-heading" className="flex flex-col gap-3">
      <h2 id="results-heading" className="text-lg font-medium">
        <span data-testid="ballot-count">
          {result.ballot_count} {result.ballot_count === 1 ? "person" : "people"} voted
        </span>
      </h2>
      {others.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {others.map((p) => (
            <li
              key={p.option_id}
              className="flex items-center justify-between rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10"
            >
              <span>
                <span className="text-muted-foreground">#{p.place}</span> {titles.get(p.option_id)}
              </span>
              <span className="text-sm text-muted-foreground">
                {p.score} {p.score === 1 ? "point" : "points"}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
