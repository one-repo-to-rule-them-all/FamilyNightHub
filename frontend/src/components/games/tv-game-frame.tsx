import type { ReactNode } from "react";

import { PlayerStrip } from "@/components/games/player-strip";
import type { StripPlayer } from "@/lib/game-layout";

/**
 * The TV's game template (04-frontend.md, "Game layout template"): a header, a stage that takes
 * the height that is left, and the player strip pinned to the foot. It fills the `/tv` layout's one
 * viewport (`flex-1 min-h-0`), so the strip is always on screen, fullscreen or not. Type is in the
 * TV's `em` scale; the stage scrolls only if a very short window cannot fit it.
 *
 * `attrs` lands on the root (`data-testid`, `data-status`, `data-live`, ...), so a game keeps the
 * hooks its specs read.
 */
export function TvGameFrame({
  title,
  subtitle,
  banner,
  players,
  playerTestId,
  emptyPlayersText,
  attrs,
  maxWidth = "64em",
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** A polite live region (win announcements) between the header and the stage. */
  banner?: ReactNode;
  players: readonly StripPlayer[];
  playerTestId?: string;
  emptyPlayersText?: string;
  attrs: Record<`data-${string}`, string | boolean | undefined>;
  maxWidth?: string;
  children: ReactNode;
}) {
  return (
    <div
      {...attrs}
      className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-[1em] text-center"
      style={{ maxWidth }}
    >
      <header className="tv-clear-corner-centered shrink-0">
        <h1 className="tv-title">{title}</h1>
        {subtitle ? (
          <div className="tv-body mt-[0.3em] text-muted-foreground">{subtitle}</div>
        ) : null}
      </header>
      {banner ? <div className="shrink-0">{banner}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="game-stage">
        <div className="m-auto flex w-full flex-col items-center gap-[1.25em] py-[0.25em]">
          {children}
        </div>
      </div>
      <footer className="shrink-0 border-t border-foreground/10 pt-[0.8em] pb-[max(0.2em,env(safe-area-inset-bottom,0px))]">
        <PlayerStrip
          players={players}
          variant="tv"
          itemTestId={playerTestId}
          emptyText={emptyPlayersText}
        />
      </footer>
    </div>
  );
}
