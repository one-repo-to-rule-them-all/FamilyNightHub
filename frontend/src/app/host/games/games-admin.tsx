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
import { WIN_MODE_COPY, type WinMode } from "@/lib/bingo";
import { KIND_COPY, PLAYABLE, statusLabel } from "@/lib/games";

/** Start a Gratitude Jar or a bingo round and list the household's games. */
export function GamesAdmin() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("Thanksgiving gratitude jar");
  const [allowAnonymous, setAllowAnonymous] = useState(true);
  const [bingoTitle, setBingoTitle] = useState("Thanksgiving bingo");
  const [winMode, setWinMode] = useState<WinMode>("line");
  const [freeCenter, setFreeCenter] = useState(true);
  const [endOnFirstWin, setEndOnFirstWin] = useState(true);

  const games = useQuery<GameSummary[], ApiError>({
    queryKey: ["games"],
    queryFn: api.games,
    refetchInterval: 10_000,
  });
  const create = useMutation<Game, ApiError>({
    mutationFn: () =>
      api.createGame({ kind: "gratitude_jar", title, allow_anonymous: allowAnonymous }),
    onSuccess: (game) => {
      void queryClient.invalidateQueries({ queryKey: ["games"] });
      router.push(`/host/games/${game.id}`);
    },
  });

  const createBingo = useMutation<Game, ApiError>({
    mutationFn: () =>
      api.createGame({
        kind: "bingo",
        title: bingoTitle,
        win_mode: winMode,
        free_center: freeCenter,
        end_on_first_win: endOnFirstWin,
      }),
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
          if (title.trim() && !create.isPending) create.mutate();
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
          if (bingoTitle.trim() && !createBingo.isPending) createBingo.mutate();
        }}
      >
        <h2 className="text-lg font-medium">Start a bingo round</h2>
        <p className="text-sm text-muted-foreground">{KIND_COPY.bingo.blurb}</p>
        <Label htmlFor="bingo-title">Name</Label>
        <Input
          id="bingo-title"
          data-testid="bingo-title"
          value={bingoTitle}
          maxLength={80}
          onChange={(event) => setBingoTitle(event.target.value)}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">What wins</legend>
          {(Object.keys(WIN_MODE_COPY) as WinMode[]).map((mode) => (
            <label key={mode} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                name="win-mode"
                data-testid={`win-mode-${mode}`}
                checked={winMode === mode}
                onChange={() => setWinMode(mode)}
                className="size-5 accent-[var(--accent-cinema)]"
              />
              <span>
                {WIN_MODE_COPY[mode].name}
                <span className="block text-sm text-muted-foreground">
                  {WIN_MODE_COPY[mode].blurb}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={freeCenter}
            onChange={(event) => setFreeCenter(event.target.checked)}
            className="size-5 accent-[var(--accent-cinema)]"
          />
          Free space in the middle
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={endOnFirstWin}
            onChange={(event) => setEndOnFirstWin(event.target.checked)}
            className="size-5 accent-[var(--accent-cinema)]"
          />
          The first win ends the round
        </label>
        <ApiErrorNotice error={createBingo.error} />
        <Button
          type="submit"
          data-testid="create-bingo"
          disabled={!bingoTitle.trim() || createBingo.isPending}
        >
          <Plus aria-hidden /> Start bingo
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
