"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type Game, type GameSummary } from "@/lib/api";
import { KIND_COPY, PLAYABLE, statusLabel } from "@/lib/games";

/** Start a Gratitude Jar or Scattergories and list the household's games. Bingo joins later. */
export function GamesAdmin() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("Thanksgiving gratitude jar");
  const [allowAnonymous, setAllowAnonymous] = useState(true);
  const [scatterTitle, setScatterTitle] = useState("Thanksgiving scattergories");

  const games = useQuery<GameSummary[], ApiError>({
    queryKey: ["games"],
    queryFn: api.games,
    refetchInterval: 10_000,
  });
  const create = useMutation<Game, ApiError, "gratitude_jar" | "scattergories">({
    mutationFn: (kind) =>
      api.createGame(
        kind === "gratitude_jar"
          ? { kind, title, allow_anonymous: allowAnonymous }
          : { kind, title: scatterTitle, allow_anonymous: true },
      ),
    onSuccess: (game) => {
      void queryClient.invalidateQueries({ queryKey: ["games"] });
      router.push(`/host/games/${game.id}`);
    },
  });

  return (
    <div className="flex flex-col gap-6" data-screen="portal-games">
      <h1 className="font-heading text-2xl font-semibold">Games</h1>

      <form
        className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() && !create.isPending) create.mutate("gratitude_jar");
        }}
      >
        <h2 className="text-lg font-medium">
          Start a {KIND_COPY.gratitude_jar.name.toLowerCase()}
        </h2>
        <p className="text-sm text-muted-foreground">{KIND_COPY.gratitude_jar.blurb}</p>
        <Label htmlFor="game-title">Name</Label>
        <Input
          id="game-title"
          data-testid="game-title"
          value={title}
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={allowAnonymous}
            onChange={(event) => setAllowAnonymous(event.target.checked)}
            className="size-5 accent-[var(--accent-cinema)]"
          />
          Let people leave their name off a note
        </label>
        <ApiErrorNotice error={create.error} />
        <Button
          type="submit"
          data-testid="create-game"
          disabled={!title.trim() || create.isPending}
        >
          <Plus aria-hidden /> Start jar
        </Button>
      </form>

      <form
        className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (scatterTitle.trim() && !create.isPending) create.mutate("scattergories");
        }}
      >
        <h2 className="text-lg font-medium">Start {KIND_COPY.scattergories.name.toLowerCase()}</h2>
        <p className="text-sm text-muted-foreground">{KIND_COPY.scattergories.blurb}</p>
        <Label htmlFor="scatter-title">Name</Label>
        <Input
          id="scatter-title"
          data-testid="scatter-title"
          value={scatterTitle}
          maxLength={80}
          onChange={(event) => setScatterTitle(event.target.value)}
        />
        <Button
          type="submit"
          data-testid="create-scatter"
          disabled={!scatterTitle.trim() || create.isPending}
        >
          <Plus aria-hidden /> Start scattergories
        </Button>
      </form>

      <section className="flex flex-col gap-2" aria-label="Your games">
        <h2 className="text-lg font-medium">Your games</h2>
        {games.data?.filter((g) => PLAYABLE.includes(g.kind)).length === 0 ? (
          <p className="text-muted-foreground">Nothing yet. Start one above.</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {games.data
            ?.filter((g) => PLAYABLE.includes(g.kind))
            .map((game) => (
              <li key={game.id}>
                <Link
                  href={`/host/games/${game.id}`}
                  data-testid="host-game-row"
                  className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{game.title}</span>
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
    </div>
  );
}
