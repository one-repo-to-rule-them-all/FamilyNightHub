"use client";

import { Countdown, Leaderboard, LetterTile, Results } from "@/components/games/scatter-parts";
import { TvGameFrame } from "@/components/games/tv-game-frame";
import { useLiveGame } from "@/hooks/use-live-game";
import { useScatterClock } from "@/hooks/use-scatter-clock";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { scatterStripPlayers } from "@/lib/game-layout";
import { roundHeading } from "@/lib/scatter";

/**
 * /tv/games/[game] for Scattergories (ADR-0018 slice C): the lobby, then the letter, the
 * categories and a big countdown, then "time's up", then every answer with its score and the
 * leaderboard once the host reveals. The snapshot never holds an answer before reveal, so
 * nothing here can leak one. The TV's clock follows the server's `ends_at`. Laid out on the TV game
 * template: the players (with how many answers each has in) are the footer strip.
 */
export function TvScatter({ gameId }: { gameId: string }) {
  const game = useLiveGame(gameId);
  useWakeLock();
  const data = game.data;
  const scatter = data?.scatter ?? undefined;
  const { state, seconds, round } = useScatterClock(scatter, game.dataUpdatedAt);
  const lastRevealed = scatter?.revealed.at(-1);

  if (game.error) {
    return (
      <p className="tv-title m-auto text-center" data-testid="tv-unpaired">
        This screen can&apos;t reach the game. A host pairs it with{" "}
        <strong>Use this browser as the TV</strong>.
      </p>
    );
  }

  const announcement =
    state === "closed" ? "Time is up." : state === "revealed" ? "Answers revealed." : "";

  return (
    <TvGameFrame
      title={data?.title ?? "Scattergories"}
      players={scatterStripPlayers(
        scatter?.players ?? [],
        round && (state === "running" || state === "closed") ? round.categories.length : null,
      )}
      playerTestId="tv-player"
      emptyPlayersText="Players show up here as they join from their phones"
      attrs={{
        "data-testid": "tv-scatter",
        "data-status": data?.status,
        "data-round-state": state,
        "data-live": game.live,
      }}
    >
      <p role="status" aria-live="polite" className="sr-only" data-testid="tv-announce">
        {announcement}
      </p>

      {scatter && state === "lobby" ? (
        <p className="tv-body text-muted-foreground" data-testid="tv-scatter-lobby">
          {data?.status === "ended"
            ? "That is the game. Thank you, everyone."
            : "Join from your phone: Games, then " + (data?.title ?? "this game") + "."}
        </p>
      ) : null}

      {scatter && round && (state === "running" || state === "closed") ? (
        <>
          <h2 className="tv-body text-muted-foreground" data-testid="tv-round-heading">
            {roundHeading(round.round_no, round.letter)}
          </h2>
          <div className="flex items-center gap-[1.5em]">
            <LetterTile letter={round.letter} tv />
            <div className="min-w-[8em]">
              <Countdown seconds={seconds} duration={round.duration_seconds} tv />
            </div>
          </div>
          {state === "closed" ? (
            <p className="tv-title" data-testid="tv-time-up">
              Time is up!
            </p>
          ) : null}
          <ol className="tv-body grid w-full grid-cols-1 gap-[0.4em] text-left sm:grid-cols-2">
            {round.categories.map((c, i) => (
              <li
                key={c}
                className="rounded-[0.6em] border border-foreground/10 bg-card px-[0.8em] py-[0.4em]"
              >
                {i + 1}. {c}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {scatter && state === "revealed" && lastRevealed ? (
        <div className="flex w-full flex-col gap-[1em] text-left">
          <h2 className="tv-body text-center" data-testid="tv-round-heading">
            {roundHeading(lastRevealed.round_no, lastRevealed.letter)} results
          </h2>
          <Results round={lastRevealed} standings={scatter.leaderboard} tv />
        </div>
      ) : null}

      {scatter && scatter.revealed.length > 0 ? (
        <Leaderboard standings={scatter.leaderboard} tv />
      ) : null}
    </TvGameFrame>
  );
}
