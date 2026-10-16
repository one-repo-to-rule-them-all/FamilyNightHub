"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type BulkLine, type BulkPick, type BulkResult } from "@/lib/api";
import { MAX_BULK_LINES, parseBulkTitles } from "@/lib/bulk-titles";

import { LIBRARY_KEY } from "./movie-library";

/** Per open line: a TMDB id to use, "typed" to add the title without TMDB, or "skip". */
type Choice = `tmdb:${number}` | "typed" | "skip";

const OPEN = new Set<BulkLine["status"]>(["ambiguous", "not_found"]);

function label(line: { title: string; year: number | null }): string {
  return line.year ? `${line.title} (${line.year})` : line.title;
}

function defaultChoice(line: BulkLine): Choice {
  const first = line.candidates[0];
  return line.status === "ambiguous" && first ? `tmdb:${first.tmdb_id}` : "skip";
}

function toPick(line: BulkLine, choice: Choice): BulkPick {
  const pick: BulkPick = { title: line.title, year: line.year };
  return choice.startsWith("tmdb:") ? { ...pick, tmdb_id: Number(choice.slice(5)) } : pick;
}

export function BulkAdd() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [lines, setLines] = useState<BulkLine[] | null>(null);
  const [tmdbDown, setTmdbDown] = useState(false);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  // Open lines the admin already answered (picked, typed or skipped).
  const [settled, setSettled] = useState<ReadonlySet<number>>(new Set());
  const parsed = parseBulkTitles(text);

  const refreshLibrary = () => queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });

  const add = useMutation<BulkResult, ApiError>({
    mutationFn: () => api.bulkAddMovies(parsed.titles),
    onSuccess: (result) => {
      setLines(result.lines);
      setTmdbDown(result.tmdb_unavailable);
      setChoices(Object.fromEntries(result.lines.map((line, i) => [i, defaultChoice(line)])));
      setSettled(new Set());
      setText("");
      void refreshLibrary();
    },
  });

  const open = (lines ?? [])
    .map((line, index) => ({ line, index }))
    .filter((x) => OPEN.has(x.line.status) && !settled.has(x.index));
  const picks = open.filter(({ index }) => choices[index] !== "skip");

  const confirm = useMutation<BulkResult, ApiError>({
    mutationFn: () =>
      api.confirmBulkMovies(picks.map(({ line, index }) => toPick(line, choices[index]!))),
    onSuccess: (result) => {
      const resolved = new Map(picks.map(({ index }, i) => [index, result.lines[i]!]));
      setLines((current) => (current ?? []).map((line, index) => resolved.get(index) ?? line));
      setSettled(new Set([...settled, ...open.map(({ index }) => index)]));
      setTmdbDown(tmdbDown || result.tmdb_unavailable);
      void refreshLibrary();
    },
  });

  return (
    <section aria-labelledby="bulk-heading" className="flex flex-col gap-4">
      <h2 id="bulk-heading" className="font-heading text-2xl font-semibold">
        Add owned titles
      </h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.titles.length > 0) add.mutate();
        }}
      >
        <Label htmlFor="bulk-titles" className="text-base">
          One title per line, optional (year)
        </Label>
        <textarea
          id="bulk-titles"
          rows={6}
          className="rounded-lg border border-input bg-transparent p-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder={"Paddington 2 (2017)\nToy Story\nCoco"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby="bulk-hint"
        />
        <p id="bulk-hint" className="text-sm text-muted-foreground">
          {parsed.titles.length} title{parsed.titles.length === 1 ? "" : "s"}
          {parsed.overflow > 0
            ? ` — only the first ${MAX_BULK_LINES} are added; paste the other ${parsed.overflow} next.`
            : ""}
        </p>
        <Button
          type="submit"
          size="tap"
          className="self-start"
          disabled={parsed.titles.length === 0 || add.isPending}
        >
          {add.isPending ? "Looking them up…" : "Add to library"}
        </Button>
      </form>
      <ApiErrorNotice error={add.error} />

      {lines ? (
        <div className="flex flex-col gap-4" data-testid="bulk-results">
          {tmdbDown ? (
            <p role="status" className="rounded-xl bg-card p-4">
              TMDB is unavailable, so some titles were added as typed, without a poster or runtime.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {lines.map((line, index) => (
              <li
                key={index}
                className="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
                data-testid="bulk-line"
                data-status={line.status}
              >
                {OPEN.has(line.status) && !settled.has(index) && choices[index] ? (
                  <OpenLine
                    line={line}
                    index={index}
                    choice={choices[index]}
                    onChoose={(choice) => setChoices({ ...choices, [index]: choice })}
                  />
                ) : (
                  <p>
                    <strong>{label(line)}</strong> — {settledText(line)}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {open.length > 0 ? (
            <Button
              size="tap"
              className="self-start"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              Confirm choices
            </Button>
          ) : null}
          <ApiErrorNotice error={confirm.error} />
        </div>
      ) : null}
    </section>
  );
}

function settledText(line: BulkLine): string {
  if (line.status === "matched") {
    const found = line.movie ? label(line.movie) : line.title;
    return line.already_owned ? `already owned (${found})` : `added: ${found}`;
  }
  if (line.status === "added_manual") return "added as typed (no TMDB match)";
  return "not added";
}

function OpenLine({
  line,
  index,
  choice,
  onChoose,
}: {
  line: BulkLine;
  index: number;
  choice: Choice;
  onChoose: (choice: Choice) => void;
}) {
  const name = `bulk-choice-${index}`;
  const options: { value: Choice; text: string }[] = [
    ...line.candidates.map((c) => ({ value: `tmdb:${c.tmdb_id}` as Choice, text: label(c) })),
    { value: "typed", text: "Add as typed" },
    { value: "skip", text: "Skip" },
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1">
        <strong>{label(line)}</strong> —{" "}
        {line.status === "ambiguous" ? "which one did you mean?" : "no match on TMDB"}
      </legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-3 text-base">
          <input
            type="radio"
            className="size-5 accent-primary"
            name={name}
            value={option.value}
            checked={choice === option.value}
            onChange={() => onChoose(option.value)}
          />
          {option.text}
        </label>
      ))}
    </fieldset>
  );
}
