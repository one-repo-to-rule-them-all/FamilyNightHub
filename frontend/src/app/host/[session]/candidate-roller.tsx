"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Dices, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nightKey } from "@/hooks/use-live-session";
import { api, type ApiError, type Night, type Schemas } from "@/lib/api";
import {
  AGE_CAPS,
  type Candidate,
  candidateKey,
  candidateMeta,
  type CapChoice,
  COUNT_MAX,
  COUNT_MIN,
  DEFAULT_ROLL,
  type Genre,
  GENRES,
  isOnShortlist,
  parseMaxRuntime,
  type RollForm,
  RUNTIME_MAX,
  RUNTIME_MIN,
  slotsLeft,
  sourceLabel,
  toGenerateBody,
  toOptionIn,
} from "@/lib/candidates";
import { MAX_OPTIONS } from "@/lib/shortlist";
import { cn } from "@/lib/utils";

type Roll = Schemas["GenerateOut"];

/** Shown before the first roll; afterwards the response's own `attribution.tmdb` string is. */
const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

const SELECT_CLASS =
  "h-12 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const BADGE_CLASS: Record<Candidate["source"], string> = {
  owned: "bg-cinema-muted text-foreground",
  streaming: "bg-secondary text-secondary-foreground",
  tmdb: "bg-muted text-foreground",
};

/**
 * "Roll candidates" (ADR-0007): owned titles first, then the household's streaming services,
 * then anywhere on TMDB. The roll only suggests; each pick is added through the shortlist
 * endpoint with its source (`lib/candidates.ts`), so the 2..8 limit is the server's as always.
 */
export function CandidateRoller({ night }: { night: Night }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RollForm>(DEFAULT_ROLL);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const body = toGenerateBody(form);
  const runtimeInvalid = Number.isNaN(parseMaxRuntime(form.maxRuntime));
  const left = slotsLeft(night.options.length);
  const optionMovieIds = new Set(night.options.map((o) => o.movie_id));

  const roll = useMutation<Roll, ApiError, Schemas["GenerateIn"]>({
    mutationFn: (request) => api.generate(night.id, request),
  });
  const add = useMutation<Night, ApiError, Candidate>({
    mutationFn: (candidate) => {
      const option = toOptionIn(candidate);
      if (!option) throw new Error("This title can't be added.");
      return api.addOption(night.id, option);
    },
    onSuccess: (next, candidate) => {
      queryClient.setQueryData(nightKey(night.id), next);
      setAdded((prev) => new Set(prev).add(candidateKey(candidate)));
    },
  });

  const result = roll.data;
  const showsStreaming = result?.candidates.some((c) => c.source === "streaming") ?? false;
  const update = (patch: Partial<RollForm>) => setForm((prev) => ({ ...prev, ...patch }));

  return (
    <section aria-labelledby="roll-candidates" className="flex flex-col gap-4">
      <h2 id="roll-candidates" className="flex items-center gap-2 text-xl font-semibold">
        <Dices aria-hidden className="size-5 text-cinema" /> Roll candidates
      </h2>
      <p className="text-muted-foreground">
        Titles you own come first, then your streaming services, then anything on TMDB. Nothing is
        added until you pick it.
      </p>

      <form
        aria-label="Roll options"
        className="grid grid-cols-2 gap-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/10"
        onSubmit={(event) => {
          event.preventDefault();
          if (body && !roll.isPending) roll.mutate(body);
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="roll-count">How many</Label>
          <Input
            id="roll-count"
            type="number"
            inputMode="numeric"
            min={COUNT_MIN}
            max={COUNT_MAX}
            value={Number.isNaN(form.count) ? "" : form.count}
            onChange={(event) => update({ count: event.target.valueAsNumber })}
            className="h-12 text-base"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="roll-genre">Genre</Label>
          <select
            id="roll-genre"
            value={form.genre}
            onChange={(event) => update({ genre: event.target.value as Genre | "" })}
            className={SELECT_CLASS}
          >
            <option value="">Any genre</option>
            {GENRES.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="roll-runtime">Max minutes</Label>
          <Input
            id="roll-runtime"
            inputMode="numeric"
            placeholder="Any length"
            value={form.maxRuntime}
            maxLength={3}
            aria-invalid={runtimeInvalid || undefined}
            aria-describedby={runtimeInvalid ? "roll-runtime-error" : undefined}
            onChange={(event) => update({ maxRuntime: event.target.value.replace(/\D/g, "") })}
            className="h-12 text-base"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="roll-cap">Age cap</Label>
          <select
            id="roll-cap"
            value={form.cap}
            onChange={(event) => update({ cap: event.target.value as CapChoice })}
            className={SELECT_CLASS}
          >
            <option value="night">Night&apos;s usual cap</option>
            {AGE_CAPS.map((cap) => (
              <option key={cap} value={cap}>
                Up to {cap}
              </option>
            ))}
            <option value="none">No cap tonight</option>
          </select>
        </div>
        {runtimeInvalid ? (
          <p id="roll-runtime-error" className="col-span-2 text-sm text-destructive">
            Max minutes must be between {RUNTIME_MIN} and {RUNTIME_MAX}.
          </p>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          size="tap"
          className="col-span-2"
          disabled={!body || roll.isPending}
        >
          {result ? <RefreshCw aria-hidden /> : <Dices aria-hidden />}
          {roll.isPending ? "Rolling…" : result ? "Re-roll" : "Roll candidates"}
        </Button>
      </form>

      <ApiErrorNotice error={roll.error ?? add.error} />

      {result ? (
        <div className="flex flex-col gap-3" data-testid="roll-results">
          {result.tmdb_unavailable ? (
            <p
              role="status"
              data-testid="roll-tmdb-unavailable"
              className="rounded-xl bg-muted p-4 text-base"
            >
              TMDB unavailable, owned titles only.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {result.candidates.length === 0
              ? "Nothing matched. Try another genre, a longer runtime or a different cap."
              : `${result.candidates.length} ${result.candidates.length === 1 ? "title" : "titles"}` +
                (result.age_cap ? `, rated ${result.age_cap} or milder.` : ", no age cap.")}
          </p>
          {left === 0 ? (
            <p className="text-muted-foreground" data-testid="roll-full">
              The shortlist is full ({MAX_OPTIONS} titles). Remove one to add another.
            </p>
          ) : null}
          {result.candidates.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="Candidates">
              {result.candidates.map((candidate) => (
                <CandidateCard
                  key={candidateKey(candidate)}
                  candidate={candidate}
                  onShortlist={isOnShortlist(candidate, optionMovieIds, added)}
                  disabled={left === 0 || add.isPending}
                  onAdd={() => add.mutate(candidate)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p data-testid="roll-tmdb-attribution">
          {result?.attribution.tmdb ?? TMDB_NOTICE}{" "}
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            themoviedb.org
          </a>
        </p>
        {showsStreaming && result?.attribution.justwatch ? (
          <p data-testid="roll-justwatch-attribution">
            {result.attribution.justwatch}{" "}
            <a
              href="https://www.justwatch.com/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              justwatch.com
            </a>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CandidateCard({
  candidate,
  onShortlist,
  disabled,
  onAdd,
}: {
  candidate: Candidate;
  onShortlist: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const label = candidate.year ? `${candidate.title} (${candidate.year})` : candidate.title;
  const meta = candidateMeta(candidate);
  const addable = toOptionIn(candidate) !== null;
  return (
    <li
      data-testid="candidate"
      data-source={candidate.source}
      className="flex items-center gap-3 rounded-xl bg-card p-2 ring-1 ring-foreground/10"
    >
      <Poster
        title={candidate.title}
        posterPath={candidate.poster_path}
        width="w185"
        label={false}
        className="w-16 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          data-testid="candidate-title"
          className="line-clamp-2 text-lg leading-tight font-medium break-words"
        >
          {candidate.title}
        </span>
        {meta ? <span className="text-sm text-muted-foreground">{meta}</span> : null}
        <span className="flex flex-wrap gap-1">
          <span
            data-testid="candidate-source"
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-medium",
              BADGE_CLASS[candidate.source],
            )}
          >
            {sourceLabel(candidate)}
          </span>
          {candidate.us_cert ? (
            <span
              data-testid="candidate-cert"
              className="rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-foreground/20"
            >
              <span className="sr-only">Rated </span>
              {candidate.us_cert}
            </span>
          ) : null}
        </span>
      </span>
      {onShortlist ? (
        <span className="flex shrink-0 items-center gap-1 px-2 text-sm text-cinema">
          <Check aria-hidden className="size-4" /> Added
        </span>
      ) : (
        <Button
          variant="secondary"
          size="lg"
          className="h-12 shrink-0"
          aria-label={`Add ${label} to shortlist`}
          disabled={disabled || !addable}
          onClick={onAdd}
        >
          <Plus aria-hidden /> Add
        </Button>
      )}
    </li>
  );
}
