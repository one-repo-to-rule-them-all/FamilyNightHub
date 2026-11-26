"use client";

import { Clapperboard } from "lucide-react";
import { useState } from "react";

import type { ReelWindow } from "@/lib/reel";

/**
 * Host entry for the night reel (ADR-0018 amendment): one TV page that cycles the night's
 * quotes, winners and photos. Open it in a tab, or copy the link into the paired TV's browser
 * ("Show on TV" for the reel is deferred, see the ADR's OPEN 3).
 */
export function NightReelCard() {
  const [selected, setSelected] = useState<ReelWindow>("tonight");
  const path = selected === "all" ? "/tv/reel?window=all" : "/tv/reel";
  return (
    <section
      aria-label="Night reel"
      data-testid="night-reel-card"
      className="flex flex-col gap-2 rounded-xl border bg-card p-3"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Clapperboard aria-hidden className="size-4" />
        Night reel
      </h2>
      <p className="text-sm text-muted-foreground">
        Quotes, winners, scores and photos from the games, cycling on their own in random order.
        Hidden notes and photos never show.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="reel-window">
          Show
        </label>
        <select
          id="reel-window"
          data-testid="reel-window"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value === "all" ? "all" : "tonight")}
        >
          <option value="tonight">Tonight (last 12 hours)</option>
          <option value="all">All time</option>
        </select>
        <a
          href={path}
          target="fnh-reel"
          rel="noopener"
          data-testid="open-reel"
          className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          Open the reel
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        For the TV: open <code data-testid="reel-link">{path}</code> in the TV&apos;s browser.
      </p>
    </section>
  );
}
