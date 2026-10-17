import Link from "next/link";

import { Poster } from "@/components/night/poster";
import { ratingLine, type Stats } from "@/lib/portal";

type LastNight = NonNullable<Stats["last"]> & {
  winner: { title: string; poster_path?: string | null } | null;
};

/** At a glance (§5 P1b): last night, this month, turnout. Photos joins once gap O1 ships. */
export function QuickStats({
  stats,
  lastHref,
}: {
  stats: Stats;
  lastHref: (id: string) => string;
}) {
  const last = stats.last as LastNight | null;
  const tile = "flex min-w-0 flex-col gap-1.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10";

  return (
    <section aria-labelledby="stats-title" data-testid="stats" className="flex flex-col gap-3">
      <h2
        id="stats-title"
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        At a glance
      </h2>
      {!last ? (
        <p className="text-muted-foreground">Your first night will show up here.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Link
            href={lastHref(last.id)}
            data-stat="last"
            className={`${tile} col-span-2 flex-row items-center gap-3 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 lg:col-span-1`}
          >
            {last.winner?.poster_path !== undefined ? (
              <Poster
                posterPath={last.winner?.poster_path ?? null}
                title={last.winner?.title ?? ""}
                className="w-12 shrink-0 rounded-md"
              />
            ) : null}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-muted-foreground">Last night</span>
              <span className="truncate font-medium">
                {last.winner?.title ?? last.title ?? "Movie night"}
              </span>
              <span className="text-sm text-muted-foreground">
                {new Date(last.created_at).toLocaleDateString([], {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
                {ratingLine(last.rating) ? ` · ★ ${ratingLine(last.rating)}` : ""}
              </span>
            </span>
          </Link>
          <div className={tile} data-stat="month">
            <span className="text-sm text-muted-foreground">This month</span>
            <span className="text-2xl font-semibold tabular-nums">{stats.thisMonth}</span>
            <span className="text-sm text-muted-foreground">
              {stats.thisMonth === 1 ? "night" : "nights"}
            </span>
          </div>
          {stats.turnout.length > 0 ? <Turnout series={stats.turnout} className={tile} /> : null}
        </div>
      )}
    </section>
  );
}

function Turnout({ series, className }: { series: number[]; className: string }) {
  const max = Math.max(1, ...series);
  const latest = series[series.length - 1];
  return (
    <div className={className} data-stat="turnout">
      <span className="text-sm text-muted-foreground">Turnout</span>
      <span className="text-2xl font-semibold tabular-nums">{latest}</span>
      <div
        role="img"
        aria-label={`Turnout over the last ${series.length} nights: ${series.join(", ")}`}
        className="flex h-10 items-end gap-1"
      >
        {series.map((value, index) => (
          <span
            // Position is the identity here: oldest → newest.
            key={index}
            className={`flex-1 rounded-t-sm ${index === series.length - 1 ? "bg-foreground/70" : "bg-foreground/25"}`}
            style={{ height: `${Math.max(6, (value / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
