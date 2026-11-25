"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Monitor, Play, SkipForward, Square } from "lucide-react";
import Link from "next/link";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { api, type ApiError, type Game, type ModerationNote } from "@/lib/api";
import { jarProgress, statusLabel } from "@/lib/games";

/**
 * Run a Gratitude Jar (ADR-0018): read and hide notes before they show, start the reveal, show
 * the next note, end it. The moderation list carries note text for the host only, and never the
 * author of an anonymous note. Everything refetches on the game's live hints.
 */
export function JarHost({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const moderation = useQuery<ModerationNote[], ApiError>({
    queryKey: ["game", gameId, "moderation"],
    queryFn: () => api.jarModeration(gameId),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] });

  const step = useMutation<Game, ApiError, "start" | "next" | "end">({
    mutationFn: (action) =>
      action === "start"
        ? api.startJarReveal(gameId)
        : action === "next"
          ? api.jarRevealNext(gameId)
          : api.endGame(gameId),
    onSuccess: refresh,
  });
  const hide = useMutation<void, ApiError, string>({
    mutationFn: (noteId) => api.hideJarNote(gameId, noteId),
    onSuccess: refresh,
  });

  const data = game.data;
  const notes = (moderation.data ?? []).filter((n) => !n.hidden_at);

  return (
    <div
      className="flex flex-col gap-5"
      data-screen="portal-game"
      data-testid="host-game"
      data-status={data?.status}
      data-live={game.live}
    >
      <ApiErrorNotice error={game.error} />
      {data ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold">{data.title}</h1>
            <p className="text-muted-foreground" data-testid="host-jar-progress">
              {statusLabel(data.kind, data.status)}
              {data.jar ? ` · ${jarProgress(data.jar.note_count, data.jar.revealed_count)}` : ""}
            </p>
          </header>

          <div className="flex flex-wrap gap-3">
            {data.status === "open" ? (
              <Button
                data-testid="start-reveal"
                disabled={!data.jar || data.jar.note_count === 0 || step.isPending}
                onClick={() => step.mutate("start")}
              >
                <Play aria-hidden /> Start the reveal
              </Button>
            ) : null}
            {data.status === "live" ? (
              <Button
                data-testid="reveal-next"
                disabled={!data.jar || data.jar.remaining === 0 || step.isPending}
                onClick={() => step.mutate("next")}
              >
                <SkipForward aria-hidden />
                {data.jar && data.jar.revealed_count === 0 ? "Show the first note" : "Next note"}
              </Button>
            ) : null}
            {data.status !== "ended" ? (
              <Button
                variant="secondary"
                data-testid="end-game"
                disabled={step.isPending}
                onClick={() => step.mutate("end")}
              >
                <Square aria-hidden /> End
              </Button>
            ) : null}
            <Link
              href={`/tv/games/${gameId}`}
              target="fnh-tv"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-foreground/15 px-3 text-sm font-medium"
            >
              <Monitor aria-hidden className="size-4" /> Open on the TV
            </Link>
          </div>
          <ApiErrorNotice error={step.error ?? hide.error} />

          <section className="flex flex-col gap-2" aria-label="Notes in the jar">
            <h2 className="text-lg font-medium">Notes</h2>
            <p className="text-sm text-muted-foreground">
              Only you can read these before they show. Hide one to keep it off the TV.
            </p>
            {notes.length === 0 ? <p className="text-muted-foreground">No notes yet.</p> : null}
            <ul className="flex flex-col gap-2">
              {notes.map((note) => (
                <li
                  key={note.id}
                  data-testid="moderation-note"
                  data-shown={note.revealed_at ? "true" : "false"}
                  className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3"
                >
                  {note.author ? (
                    <Avatar emoji={note.author.avatar_emoji} color={note.author.color} size="sm" />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    {note.body}
                    <span className="block text-sm text-muted-foreground">
                      {note.author ? note.author.name : "Name kept off"}
                      {note.revealed_at ? " · shown" : ""}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label={`Hide: ${note.body}`}
                    disabled={hide.isPending}
                    onClick={() => hide.mutate(note.id)}
                  >
                    <EyeOff aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
