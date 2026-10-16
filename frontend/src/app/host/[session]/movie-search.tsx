"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebouncedValue } from "@/hooks/use-media";
import { nightKey } from "@/hooks/use-night-poll";
import { api, type ApiError, type Night, type Schemas, type TmdbResult } from "@/lib/api";
import { canAddOption, MAX_OPTIONS } from "@/lib/shortlist";

const SEARCH_DEBOUNCE_MS = 350;

/**
 * Add titles: poster search through the API's TMDB proxy (the browser never talks to TMDB), and a
 * typed title that always works. A 503 means TMDB is off or down; then the typed title is the way.
 */
export function MovieSearch({ night }: { night: Night }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const term = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const full = !canAddOption(night.options.length);

  const results = useQuery<TmdbResult[], ApiError>({
    queryKey: ["tmdb", term],
    queryFn: () => api.searchTmdb(term),
    enabled: term.length > 0,
    staleTime: 60_000,
  });
  const add = useMutation<Night, ApiError, Schemas["OptionIn"]>({
    mutationFn: (body) => api.addOption(night.id, body),
    onSuccess: (next) => queryClient.setQueryData(nightKey(night.id), next),
  });
  const unavailable = results.error?.status === 503;

  return (
    <section aria-labelledby="add-titles" className="flex flex-col gap-4">
      <h2 id="add-titles" className="text-xl font-semibold">
        Add titles
      </h2>
      {full ? (
        <p className="text-muted-foreground">The shortlist is full ({MAX_OPTIONS} titles).</p>
      ) : null}
      <ApiErrorNotice error={add.error} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="poster-search" className="text-base">
          Search posters
        </Label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="poster-search"
            type="search"
            value={query}
            maxLength={100}
            autoComplete="off"
            placeholder="Paddington, Up, Moana…"
            onChange={(event) => setQuery(event.target.value)}
            className="h-14 pl-12 text-lg md:text-lg"
          />
        </div>
      </div>

      {unavailable ? (
        <p
          role="status"
          data-testid="tmdb-unavailable"
          className="rounded-xl bg-muted p-4 text-base"
        >
          Poster search isn&apos;t available right now. Type the title below instead.
        </p>
      ) : (
        <ApiErrorNotice error={results.error} />
      )}

      {term && results.isFetching && !results.data ? (
        <p className="text-muted-foreground">Searching…</p>
      ) : null}
      {results.data && results.data.length === 0 && term ? (
        <p className="text-muted-foreground">No posters match “{term}”. Type the title below.</p>
      ) : null}
      {results.data && results.data.length > 0 ? (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4" aria-label="Search results">
          {results.data.slice(0, 12).map((movie) => {
            const label = movie.year ? `${movie.title} (${movie.year})` : movie.title;
            return (
              <li key={movie.tmdb_id} className="flex flex-col gap-1">
                <Poster title={movie.title} posterPath={movie.poster_path} width="w185" />
                <span className="line-clamp-2 text-sm leading-tight">{label}</span>
                <Button
                  variant="secondary"
                  size="lg"
                  className="h-11"
                  aria-label={`Add ${label}`}
                  disabled={full || add.isPending}
                  onClick={() => add.mutate({ tmdb_id: movie.tmdb_id })}
                >
                  <Plus aria-hidden /> Add
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ManualTitle disabled={full || add.isPending} onAdd={(body) => add.mutateAsync(body)} />

      <p className="text-xs text-muted-foreground" data-testid="tmdb-attribution">
        Movie data and posters from TMDB. This product uses the TMDB API but is not endorsed or
        certified by TMDB.
      </p>
    </section>
  );
}

function ManualTitle({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (body: Schemas["OptionIn"]) => Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const parsedYear = year.trim() ? Number(year) : null;
  const yearValid =
    parsedYear === null ||
    (Number.isInteger(parsedYear) && parsedYear >= 1870 && parsedYear <= 2100);

  return (
    <form
      aria-labelledby="manual-title"
      className="flex flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/10"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || !yearValid || disabled) return;
        onAdd({ title: title.trim(), year: parsedYear })
          .then(() => {
            setTitle("");
            setYear("");
          })
          .catch(() => undefined); // shown by the parent's error notice
      }}
    >
      <h3 id="manual-title" className="text-base font-medium">
        Can&apos;t find it? Type the title
      </h3>
      <div className="grid grid-cols-[1fr_7rem] gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="manual-title-input">Movie title</Label>
          <Input
            id="manual-title-input"
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
            className="h-12 text-lg md:text-lg"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="manual-year-input">Year (optional)</Label>
          <Input
            id="manual-year-input"
            inputMode="numeric"
            value={year}
            maxLength={4}
            aria-invalid={!yearValid || undefined}
            onChange={(event) => setYear(event.target.value.replace(/\D/g, ""))}
            className="h-12 text-lg md:text-lg"
          />
        </div>
      </div>
      <Button
        type="submit"
        variant="secondary"
        size="tap"
        disabled={disabled || !title.trim() || !yearValid}
      >
        Add title
      </Button>
    </form>
  );
}
