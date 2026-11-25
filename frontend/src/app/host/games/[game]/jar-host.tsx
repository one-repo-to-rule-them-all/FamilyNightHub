"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Pause, Play, Shuffle, SkipForward, Square } from "lucide-react";

import { ShowOnTvButton } from "@/components/games/show-on-tv-button";
import { ApiErrorNotice } from "@/components/api-error-notice";
import { HostGameFrame } from "@/components/games/host-game-frame";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { api, type ApiError, type Game, type ModerationNote } from "@/lib/api";
import { jarStripPlayers } from "@/lib/game-layout";
import { useJarCycle } from "@/hooks/use-jar-cycle";
import { jarStatusLine, statusLabel } from "@/lib/games";
import { cycleCounter } from "@/lib/jar-cycle";

/**
 * Run a Gratitude Jar (ADR-0018): read and hide notes before they show, start the reveal, end it.
 * A cycling jar (the default) then shows every unhidden note on its own, so the host can Pause,
 * Resume, Reshuffle or Hide; a manual jar still has Next note. The moderation list carries note text for the host only, and never the
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

  const step = useMutation<
    Game,
    ApiError,
    "start" | "next" | "pause" | "resume" | "reshuffle" | "end"
  >({
    mutationFn: (action) =>
      ({
        start: api.startJarReveal,
        next: api.jarRevealNext,
        pause: api.pauseJar,
        resume: api.resumeJar,
        reshuffle: api.reshuffleJar,
        end: api.endGame,
      })[action](gameId),
    onSuccess: refresh,
  });
  const hide = useMutation<void, ApiError, string>({
    mutationFn: (noteId) => api.hideJarNote(gameId, noteId),
    onSuccess: refresh,
  });

  const data = game.data;
  const cycling = data?.jar?.mode === "cycle";
  const cycle = useJarCycle(data?.jar);
  const notes = (moderation.data ?? []).filter((n) => !n.hidden_at);

  return (
    <HostGameFrame
      title={data?.title}
      status={
        data
          ? `${statusLabel(data.kind, data.status)}${
              data.jar ? ` · ${jarStatusLine(data.jar, cycle)}` : ""
            }`
          : undefined
      }
      statusTestId="host-jar-progress"
      players={data ? jarStripPlayers(data.jar?.revealed ?? []) : undefined}
      emptyPlayersText="Names appear here as notes are revealed"
      attrs={{
        "data-screen": "portal-game",
        "data-testid": "host-game",
        "data-status": data?.status,
        "data-live": game.live,
      }}
      notice={<ApiErrorNotice error={game.error} />}
    >
      {data ? (
        <>
          <div className="flex flex-wrap gap-3">
            {data.status === "open" ? (
              <Button
                data-testid="start-reveal"
                disabled={!data.jar || data.jar.note_count === 0 || step.isPending}
                onClick={() => step.mutate("start")}
              >
                <Play aria-hidden /> {cycling ? "Start the jar" : "Start the reveal"}
              </Button>
            ) : null}
            {data.status === "live" && cycling ? (
              <>
                {data.jar?.cycle?.paused_index != null ? (
                  <Button
                    data-testid="jar-resume"
                    disabled={step.isPending}
                    onClick={() => step.mutate("resume")}
                  >
                    <Play aria-hidden /> Resume
                  </Button>
                ) : (
                  <Button
                    data-testid="jar-pause"
                    disabled={step.isPending}
                    onClick={() => step.mutate("pause")}
                  >
                    <Pause aria-hidden /> Pause
                  </Button>
                )}
                <Button
                  variant="secondary"
                  data-testid="jar-reshuffle"
                  disabled={step.isPending}
                  onClick={() => step.mutate("reshuffle")}
                >
                  <Shuffle aria-hidden /> Reshuffle
                </Button>
              </>
            ) : null}
            {data.status === "live" && !cycling ? (
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
            <ShowOnTvButton gameId={gameId} />
          </div>
          {data.status === "open" && cycling ? (
            <p className="text-sm text-muted-foreground" data-testid="jar-start-warning">
              Starting puts every note you have not hidden on the TV and on every phone, one after
              another. Read and hide first; once it starts, hiding takes a note off at once.
            </p>
          ) : null}
          {data.status === "live" && cycling && data.jar ? (
            <p className="text-sm text-muted-foreground" data-testid="host-jar-cycle">
              {cycleCounter(cycle.index, cycle.count)}
              {data.jar.cycle ? ` · ${data.jar.cycle.dwell_seconds} seconds a note` : ""}
              {cycle.paused ? " · Paused" : ""}
            </p>
          ) : null}
          <ApiErrorNotice error={step.error ?? hide.error} />

          <section className="flex flex-col gap-2" aria-label="Notes in the jar">
            <h2 className="text-lg font-medium">Notes</h2>
            <p className="text-sm text-muted-foreground">
              {cycling
                ? "Only you can read these before you start. Hide one to keep it off every screen."
                : "Only you can read these before they show. Hide one to keep it off the TV."}
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
    </HostGameFrame>
  );
}
