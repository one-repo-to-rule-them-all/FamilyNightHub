import type { ReactNode } from "react";

import { PlayerStrip } from "@/components/games/player-strip";
import { GuestShell } from "@/components/home/guest-shell";
import type { StripPlayer } from "@/lib/game-layout";

/**
 * The phone's game template (04-frontend.md, "Game layout template"): the guest shell, then a
 * header, a stage that grows to fill the screen, and the player strip stuck above the bottom nav
 * (and the safe-area inset), so it is on screen however long the stage is. 56px tap targets live
 * in the stage; the strip scrolls sideways.
 *
 * `attrs` lands on the root (`data-testid="game-screen"` is set here).
 */
export function PhoneGameFrame({
  title,
  status,
  statusTestId,
  players,
  playerTestId,
  emptyPlayersText,
  attrs,
  notice,
  children,
}: {
  /** Undefined until the snapshot arrives: the header is then left out. */
  title?: string;
  status?: ReactNode;
  statusTestId?: string;
  /** Undefined until the snapshot arrives: the footer is then left out. */
  players?: readonly StripPlayer[];
  playerTestId?: string;
  emptyPlayersText?: string;
  attrs: Record<`data-${string}`, string | boolean | undefined>;
  /** Errors and polite live regions that sit above the header. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <GuestShell screen="game" back={{ href: "/games", label: "Games" }}>
      <div {...attrs} data-testid="game-screen" className="flex flex-1 flex-col gap-5">
        {notice}
        {title ? (
          <header className="flex flex-col gap-1">
            <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
            {status ? (
              <p className="text-muted-foreground" data-testid={statusTestId}>
                {status}
              </p>
            ) : null}
          </header>
        ) : null}
        <div className="flex flex-1 flex-col gap-5" data-testid="game-stage">
          {children}
        </div>
        {players ? (
          <footer className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] z-10 -mx-5 border-t border-foreground/10 bg-background/95 px-5 py-2 backdrop-blur">
            <PlayerStrip
              players={players}
              variant="phone"
              itemTestId={playerTestId}
              emptyText={emptyPlayersText}
            />
          </footer>
        ) : null}
      </div>
    </GuestShell>
  );
}
