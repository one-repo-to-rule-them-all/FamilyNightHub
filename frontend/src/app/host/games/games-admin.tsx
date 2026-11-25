"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type Game, type GameSummary } from "@/lib/api";
import { type BingoMode, MODE_COPY, WIN_MODE_COPY, type WinMode } from "@/lib/bingo";
import { KIND_COPY, kindName, PLAYABLE, statusLabel } from "@/lib/games";
import { type LoteriaPattern, PATTERN_COPY } from "@/lib/loteria";

/** One named tab for a game's control page, so the Family Night hub tab stays where it is. */
export const GAME_WINDOW_NAME = "fnh-game";

/** Where a game's control page lives. */
const hostGameHref = (gameId: string) => `/host/games/${encodeURIComponent(gameId)}`;

/** Start a Gratitude Jar, a bingo round or Scattergories and list the household's games. */
export function GamesAdmin() {
  const queryClient = useQueryClient();
  // The control page opens in a new tab (like "Open TV window"): the tab is opened
  // synchronously inside the click, since a popup blocker only allows that, then pointed at
  // the game once it exists. If the blocker ate it, a plain link is offered instead.
  const gameTab = useRef<Window | null>(null);
  const [fallbackHref, setFallbackHref] = useState<string | null>(null);
  const openGameTab = () => {
    setFallbackHref(null);
    gameTab.current = window.open("", GAME_WINDOW_NAME);
  };
  const sendGameTab = (game: Game) => {
    void queryClient.invalidateQueries({ queryKey: ["games"] });
    const win = gameTab.current;
    gameTab.current = null;
    if (!win || win.closed) {
      setFallbackHref(hostGameHref(game.id));
      return;
    }
    win.location.replace(hostGameHref(game.id));
    win.focus();
  };
  const closeGameTab = () => {
    gameTab.current?.close();
    gameTab.current = null;
  };
  const [title, setTitle] = useState("Thanksgiving gratitude jar");
  const [allowAnonymous, setAllowAnonymous] = useState(true);
  // This year the family plays classic bingo; Thanksgiving mode stays one tap away.
  const [bingoMode, setBingoMode] = useState<BingoMode>("classic");
  const [bingoTitle, setBingoTitle] = useState("Family bingo");
  const [cycleSeconds, setCycleSeconds] = useState(12);
  const [winMode, setWinMode] = useState<WinMode>("line");
  const [freeCenter, setFreeCenter] = useState(true);
  const [endOnFirstWin, setEndOnFirstWin] = useState(true);
  const [scatterTitle, setScatterTitle] = useState("Thanksgiving scattergories");
  const [loteriaTitle, setLoteriaTitle] = useState("Lotería");
  const [pattern, setPattern] = useState<LoteriaPattern>("line");
  const [loteriaEndOnFirstWin, setLoteriaEndOnFirstWin] = useState(true);

  const games = useQuery<GameSummary[], ApiError>({
    queryKey: ["games"],
    queryFn: api.games,
    refetchInterval: 10_000,
  });
  const create = useMutation<Game, ApiError, "gratitude_jar" | "scattergories">({
    mutationFn: (kind) =>
      api.createGame(
        kind === "gratitude_jar"
          ? {
              kind,
              title,
              allow_anonymous: allowAnonymous,
              reveal_mode: "cycle",
              cycle_seconds: cycleSeconds,
            }
          : { kind, title: scatterTitle, allow_anonymous: true },
      ),
    onSuccess: sendGameTab,
    onError: closeGameTab,
  });

  const createBingo = useMutation<Game, ApiError>({
    mutationFn: () =>
      api.createGame({
        kind: "bingo",
        title: bingoTitle,
        mode: bingoMode,
        win_mode: winMode,
        free_center: freeCenter,
        end_on_first_win: endOnFirstWin,
      }),
    onSuccess: sendGameTab,
    onError: closeGameTab,
  });

  const createLoteria = useMutation<Game, ApiError>({
    mutationFn: () =>
      api.createGame({
        kind: "loteria",
        title: loteriaTitle,
        pattern,
        end_on_first_win: loteriaEndOnFirstWin,
      }),
    onSuccess: sendGameTab,
    onError: closeGameTab,
  });

  return (
    <div className="flex flex-col gap-6" data-screen="portal-games">
      <h1 className="font-heading text-2xl font-semibold">Games</h1>
      {fallbackHref ? (
        <p
          className="rounded-xl border border-foreground/10 bg-card p-3"
          data-testid="game-tab-fallback"
        >
          Your browser blocked the new tab.{" "}
          <a href={fallbackHref} target={GAME_WINDOW_NAME} className="font-medium underline">
            Open the game
          </a>
        </p>
      ) : null}

      <form
        className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() && !create.isPending) {
            openGameTab();
            create.mutate("gratitude_jar");
          }
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
        <Label htmlFor="jar-cycle-seconds">Seconds a note stays up (5 to 60)</Label>
        <Input
          id="jar-cycle-seconds"
          data-testid="jar-cycle-seconds"
          type="number"
          inputMode="numeric"
          min={5}
          max={60}
          value={cycleSeconds}
          onChange={(event) =>
            setCycleSeconds(Math.min(60, Math.max(5, Math.round(Number(event.target.value)) || 12)))
          }
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
          if (bingoTitle.trim() && !createBingo.isPending) {
            openGameTab();
            createBingo.mutate();
          }
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
          <legend className="text-sm font-medium">Kind of bingo</legend>
          {(Object.keys(MODE_COPY) as BingoMode[]).map((mode) => (
            <label key={mode} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                name="bingo-mode"
                data-testid={`bingo-mode-${mode}`}
                checked={bingoMode === mode}
                onChange={() => setBingoMode(mode)}
                className="size-5 accent-[var(--accent-cinema)]"
              />
              <span>
                {MODE_COPY[mode].name}
                <span className="block text-sm text-muted-foreground">{MODE_COPY[mode].blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>
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

      <form
        className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (scatterTitle.trim() && !create.isPending) {
            openGameTab();
            create.mutate("scattergories");
          }
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

      <form
        className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (loteriaTitle.trim() && !createLoteria.isPending) {
            openGameTab();
            createLoteria.mutate();
          }
        }}
      >
        <h2 className="text-lg font-medium">Start {KIND_COPY.loteria.name}</h2>
        <p className="text-sm text-muted-foreground">{KIND_COPY.loteria.blurb}</p>
        <Label htmlFor="loteria-title">Name</Label>
        <Input
          id="loteria-title"
          data-testid="loteria-title"
          value={loteriaTitle}
          maxLength={80}
          onChange={(event) => setLoteriaTitle(event.target.value)}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">What wins</legend>
          {(Object.keys(PATTERN_COPY) as LoteriaPattern[]).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                name="loteria-pattern"
                data-testid={`loteria-pattern-${value}`}
                checked={pattern === value}
                onChange={() => setPattern(value)}
                className="size-5 accent-[var(--accent-cinema)]"
              />
              <span>
                {PATTERN_COPY[value].name}
                <span className="block text-sm text-muted-foreground">
                  {PATTERN_COPY[value].blurb}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={loteriaEndOnFirstWin}
            onChange={(event) => setLoteriaEndOnFirstWin(event.target.checked)}
            className="size-5 accent-[var(--accent-cinema)]"
          />
          The first win ends the round
        </label>
        <ApiErrorNotice error={createLoteria.error} />
        <Button
          type="submit"
          data-testid="create-loteria"
          disabled={!loteriaTitle.trim() || createLoteria.isPending}
        >
          <Plus aria-hidden /> Start Lotería
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
                      {kindName(game.kind, game.mode)} · {statusLabel(game.kind, game.status)}
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
