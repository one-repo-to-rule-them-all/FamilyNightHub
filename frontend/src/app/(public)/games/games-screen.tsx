"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Gamepad2 } from "lucide-react";
import Link from "next/link";

import { GuestShell } from "@/components/home/guest-shell";
import { api, type ApiError, type GameSummary } from "@/lib/api";
import { KIND_COPY, PLAYABLE, statusLabel } from "@/lib/games";

const GAMES_POLL_MS = 10_000;

/**
 * The Games tab (ADR-0018): the household's games, newest first. Playable ones link to their
 * screen; the other kinds appear once their slice ships. No primary action here, it is a list.
 */
export function GamesScreen() {
  const games = useQuery<GameSummary[], ApiError>({
    queryKey: ["games"],
    queryFn: api.games,
    refetchInterval: GAMES_POLL_MS,
    refetchOnWindowFocus: true,
  });
  const playable = (games.data ?? []).filter(
    (g) => PLAYABLE.includes(g.kind) && g.status !== "draft",
  );
  const live = playable.filter((g) => g.status !== "ended");
  const done = playable.filter((g) => g.status === "ended");

  return (
    <GuestShell screen="games" back={{ href: "/", label: "Home" }}>
      <div className="flex flex-col gap-4" data-testid="games">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Games</h1>
        {games.isPending ? <p className="text-muted-foreground">Loading…</p> : null}
        {games.isSuccess && playable.length === 0 ? (
          <div
            data-testid="games-empty"
            className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-foreground/20 p-8 text-center"
          >
            <Gamepad2 aria-hidden className="size-10 text-muted-foreground" />
            <p className="text-lg font-medium">No games right now</p>
            <p className="text-muted-foreground">When the host starts one, it shows up here.</p>
          </div>
        ) : null}
        <GameList title="Happening now" games={live} />
        <GameList title="Finished" games={done} />
      </div>
    </GuestShell>
  );
}

function GameList({ title, games }: { title: string; games: GameSummary[] }) {
  if (games.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <ul className="flex flex-col gap-3">
        {games.map((game) => (
          <li key={game.id}>
            <Link
              href={`/games/${game.id}`}
              data-testid="game-card"
              data-kind={game.kind}
              data-status={game.status}
              className="flex min-h-20 items-center gap-4 rounded-2xl border border-foreground/10 bg-card p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-medium">{game.title}</span>
                <span className="block text-sm text-muted-foreground">
                  {KIND_COPY[game.kind].name} · {statusLabel(game.kind, game.status)}
                </span>
              </span>
              <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
