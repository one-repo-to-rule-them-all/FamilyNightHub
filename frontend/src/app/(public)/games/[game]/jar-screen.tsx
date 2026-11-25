"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { useLiveGame } from "@/hooks/use-live-game";
import { usePhonePeople } from "@/hooks/use-phone";
import { api, type ApiError, type JarNote, type OwnJarNote } from "@/lib/api";
import { authorLine, canSendNote, jarProgress, noteCounter, statusLabel } from "@/lib/games";
import { cn } from "@/lib/utils";

/** One revealed note, big enough to read across a room. */
function NoteCard({ note, featured }: { note: JarNote; featured?: boolean }) {
  return (
    <figure
      data-testid="jar-note"
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-card p-4",
        featured && "p-6 marquee-glow",
      )}
    >
      <blockquote className={cn("text-lg", featured && "text-2xl font-medium")}>
        {note.body}
      </blockquote>
      <figcaption className="flex items-center gap-2 text-sm text-muted-foreground">
        {note.author ? (
          <Avatar emoji={note.author.avatar_emoji} color={note.author.color} size="xs" />
        ) : null}
        {authorLine(note.author)}
      </figcaption>
    </figure>
  );
}

/**
 * /games/[game] for the Gratitude Jar (ADR-0018). While the jar is `open` the current person drops
 * notes (optionally anonymous) and can take their own back; once the host starts the reveal the
 * phone follows along with each note as it is shown. The snapshot never holds an unrevealed note,
 * so this screen only ever shows your own notes (from `/notes/mine`) plus what is on the TV.
 */
export function JarScreen({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const game = useLiveGame(gameId);
  const { current } = usePhonePeople();
  const [body, setBody] = useState("");
  const [anonymous, setAnonymous] = useState(false);

  const mine = useQuery<OwnJarNote[], ApiError>({
    queryKey: ["game", gameId, "mine"],
    queryFn: () => api.myJarNotes(gameId),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["game", gameId] });

  const drop = useMutation<OwnJarNote, ApiError>({
    mutationFn: () => {
      if (!current) throw new Error("Pick who you are first");
      return api.addJarNote(gameId, { person_id: current.id, body, anonymous });
    },
    onSuccess: () => {
      setBody("");
      refresh();
    },
  });
  const remove = useMutation<void, ApiError, string>({
    mutationFn: (noteId) => api.deleteJarNote(gameId, noteId),
    onSuccess: refresh,
  });

  const data = game.data;
  const counter = noteCounter(body);
  const ready = data?.status === "open" && current && canSendNote(body) && !drop.isPending;

  return (
    <GuestShell screen="game" back={{ href: "/games", label: "Games" }}>
      <div
        className="flex flex-col gap-5"
        data-testid="game-screen"
        data-status={data?.status}
        data-live={game.live}
      >
        {game.error ? <ApiErrorNotice error={game.error} /> : null}
        {data ? (
          <>
            <header className="flex flex-col gap-1">
              <h1 className="font-heading text-3xl font-semibold tracking-tight">{data.title}</h1>
              <p className="text-muted-foreground" data-testid="jar-progress">
                {statusLabel(data.kind, data.status)}
                {data.jar ? ` · ${jarProgress(data.jar.note_count, data.jar.revealed_count)}` : ""}
              </p>
            </header>

            {data.status === "open" ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (ready) drop.mutate();
                }}
              >
                {!current ? (
                  <p className="rounded-xl bg-muted p-4" data-testid="jar-pick-person">
                    <Link href="/who" className="font-medium underline">
                      Pick who you are
                    </Link>{" "}
                    to add a note.
                  </p>
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Avatar emoji={current.avatar_emoji} color={current.color} size="sm" />
                    Writing as {current.name}
                  </p>
                )}
                <label htmlFor="jar-note" className="text-base font-medium">
                  What are you thankful for?
                </label>
                <textarea
                  id="jar-note"
                  data-testid="jar-note-input"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={4}
                  aria-describedby="jar-counter"
                  className="min-h-32 w-full rounded-xl border border-input bg-transparent p-4 text-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p
                  id="jar-counter"
                  className={cn("text-right text-sm", counter.over && "text-destructive")}
                >
                  {counter.text}
                </p>
                {data.allow_anonymous ? (
                  <label className="flex min-h-14 items-center gap-3 rounded-xl border border-foreground/10 bg-card px-4 text-base">
                    <input
                      type="checkbox"
                      data-testid="jar-anonymous"
                      checked={anonymous}
                      onChange={(event) => setAnonymous(event.target.checked)}
                      className="size-6 accent-[var(--accent-cinema)]"
                    />
                    Keep my name off it
                  </label>
                ) : null}
                <ApiErrorNotice error={drop.error} />
                <Button
                  type="submit"
                  size="tap"
                  data-testid="primary-action"
                  aria-disabled={!ready}
                  className={cn(!ready && "opacity-50")}
                >
                  <Send aria-hidden /> Drop it in the jar
                </Button>
              </form>
            ) : null}

            {data.jar && data.status !== "open" ? (
              <section className="flex flex-col gap-3" aria-label="Notes" data-testid="jar-reveal">
                {data.jar.current ? (
                  <NoteCard note={data.jar.current} featured />
                ) : (
                  <p className="rounded-2xl bg-muted p-6 text-center text-lg">
                    The host will show the first note any moment.
                  </p>
                )}
                {data.jar.revealed.length > 1 ? (
                  <>
                    <h2 className="text-sm font-medium text-muted-foreground">Earlier notes</h2>
                    {data.jar.revealed
                      .slice(0, -1)
                      .reverse()
                      .map((note) => (
                        <NoteCard key={note.id} note={note} />
                      ))}
                  </>
                ) : null}
              </section>
            ) : null}

            {mine.data && mine.data.length > 0 ? (
              <section className="flex flex-col gap-2" aria-label="Your notes">
                <h2 className="text-sm font-medium text-muted-foreground">Your notes</h2>
                <ul className="flex flex-col gap-2">
                  {mine.data.map((note) => (
                    <li
                      key={note.id}
                      data-testid="my-note"
                      className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3"
                    >
                      <span className="min-w-0 flex-1">
                        {note.body}
                        {note.anonymous ? (
                          <span className="block text-sm text-muted-foreground">No name on it</span>
                        ) : null}
                      </span>
                      {!note.revealed && data.status === "open" ? (
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          aria-label={`Take back: ${note.body}`}
                          onClick={() => remove.mutate(note.id)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </GuestShell>
  );
}
