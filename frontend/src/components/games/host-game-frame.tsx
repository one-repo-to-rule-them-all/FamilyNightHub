import type { ReactNode } from "react";

import { PlayerStrip } from "@/components/games/player-strip";
import type { StripPlayer } from "@/lib/game-layout";

/**
 * The host's game template (04-frontend.md, "Game layout template"): a header, a
 * stage (the host's buttons come first in it), and the player strip stuck to the foot of the screen (above the portal's mobile nav).
 *
 * `attrs` lands on the root (`data-screen`, `data-testid="host-game"`, `data-status`, ...).
 */
export function HostGameFrame({
  title,
  status,
  statusTestId,
  notice,
  players,
  playerTestId,
  emptyPlayersText,
  attrs,
  children,
}: {
  /** Undefined until the snapshot arrives: header, stage and footer are then left out. */
  title?: string;
  status?: ReactNode;
  statusTestId?: string;
  notice?: ReactNode;
  players?: readonly StripPlayer[];
  playerTestId?: string;
  emptyPlayersText?: string;
  attrs: Record<`data-${string}`, string | boolean | undefined>;
  children?: ReactNode;
}) {
  return (
    <div {...attrs} className="flex flex-col gap-5">
      {notice}
      {title ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold">{title}</h1>
            {status ? (
              <p className="text-muted-foreground" data-testid={statusTestId}>
                {status}
              </p>
            ) : null}
          </header>
          <div className="flex flex-col gap-5" data-testid="game-stage">
            {children}
          </div>
          {players ? (
            <footer className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] z-10 -mx-4 border-t border-foreground/10 bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0 md:mx-0 md:px-0">
              <PlayerStrip
                players={players}
                variant="host"
                itemTestId={playerTestId}
                emptyText={emptyPlayersText}
              />
            </footer>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
