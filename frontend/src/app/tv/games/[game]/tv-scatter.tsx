"use client";

import { Countdown, Leaderboard, LetterTile, Results } from "@/components/games/scatter-parts";
import { Avatar } from "@/components/night/avatar";
import { useLiveGame } from "@/hooks/use-live-game";
import { useScatterClock } from "@/hooks/use-scatter-clock";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { answeredLine, roundHeading } from "@/lib/scatter";

/**
 * /tv/games/[game] for Scattergories (ADR-0018 slice C): the lobby, then the letter, the
 * categories and a big countdown, then "time's up", then every answer with its score and the
 * leaderboard once the host reveals. The snapshot never holds an answer before reveal, so
 * nothing here can leak one. The TV's clock follows the server's `ends_at`.
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
    <div
      className="m-auto flex w-full max-w-[64em] flex-col items-center gap-[1.25em] px-[1em] text-center"
      data-testid="tv-scatter"
      data-status={data?.status}
      data-round-state={state}
      data-live={game.live}
    >
      <h1 className="tv-title">{data?.title ?? "Scattergories"}</h1>
      <p role="status" aria-live="polite" className="sr-only" data-testid="tv-announce">
        {announcement}
      </p>

      {scatter && state === "lobby" ? (
        <div className="flex flex-col items-center gap-[1em]" data-testid="tv-scatter-lobby">
          <p className="tv-body text-muted-foreground">
            {data?.status === "ended"
              ? "That is the game. Thank you, everyone."
              : "Join from your phone: Games, then " + (data?.title ?? "this game") + "."}
          </p>
          <ul className="flex flex-wrap justify-center gap-[0.75em]">
            {scatter.players.map((p) => (
              <li key={p.person_id} className="tv-body flex items-center gap-[0.4em]">
                <Avatar emoji={p.avatar_emoji} color={p.color} size="sm" /> {p.name}
              </li>
            ))}
          </ul>
        </div>
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
          <ul className="tv-body flex flex-wrap justify-center gap-[1em] text-muted-foreground">
            {scatter.players.map((p) => (
              <li
                key={p.person_id}
                data-testid="tv-player"
                className="flex items-center gap-[0.4em]"
              >
                <Avatar emoji={p.avatar_emoji} color={p.color} size="sm" />
                {p.name} · {answeredLine(p.answered, round.categories.length)}
              </li>
            ))}
          </ul>
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
    </div>
  );
}
