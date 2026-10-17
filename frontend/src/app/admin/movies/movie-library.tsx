"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminQueryError } from "../admin-error";
import { type AdminMovie, api, type ApiError, type MovieFlags, type MoviePage } from "@/lib/api";

const PAGE_SIZE = 50;
export const LIBRARY_KEY = ["admin", "movies"] as const;

type Flag = keyof MovieFlags;
type FlagChange = Partial<Pick<AdminMovie, Flag>>;
const FLAGS: { flag: Flag; label: string }[] = [
  { flag: "owned", label: "Owned" },
  { flag: "watchlist", label: "Watchlist" },
  { flag: "blocked", label: "Blocked" },
];

const FILTERS = {
  all: {},
  owned: { owned: true },
  not_owned: { owned: false },
  watchlist: { watchlist: true },
  blocked: { blocked: true },
} as const;
type Filter = keyof typeof FILTERS;

export function MovieLibrary() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [offset, setOffset] = useState(0);
  const search = q.trim();

  const page = useQuery<MoviePage, ApiError>({
    queryKey: [...LIBRARY_KEY, { q: search, filter, offset }],
    queryFn: () => api.adminMovies({ q: search, ...FILTERS[filter], limit: PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
  });

  const update = useMutation<AdminMovie, ApiError, { id: string; flags: FlagChange }>({
    mutationFn: ({ id, flags }) => api.updateMovie(id, flags),
    // Optimistic: the box flips at once; the refetch afterwards settles filters and counts.
    onMutate: async ({ id, flags }) => {
      await queryClient.cancelQueries({ queryKey: LIBRARY_KEY });
      patchPages(id, (movie) => ({ ...movie, ...flags }));
    },
    onSuccess: (movie) => patchPages(movie.id, () => movie),
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIBRARY_KEY }),
  });

  function patchPages(id: string, change: (movie: AdminMovie) => AdminMovie) {
    queryClient.setQueriesData<MoviePage>({ queryKey: LIBRARY_KEY }, (old) =>
      old ? { ...old, items: old.items.map((m) => (m.id === id ? change(m) : m)) } : old,
    );
  }

  const columns: Column<AdminMovie>[] = [
    {
      key: "title",
      header: "Title",
      rowHeader: true,
      cell: (movie) => (
        <span className="flex flex-col">
          <span className="font-medium" data-testid="library-title">
            {movie.title}
            {movie.year ? <span className="text-muted-foreground"> ({movie.year})</span> : null}
          </span>
          {movie.tmdb_id === null ? (
            <span className="text-xs text-muted-foreground">Typed title (no TMDB match)</span>
          ) : null}
        </span>
      ),
    },
    ...FLAGS.map(({ flag, label }) => ({
      key: flag,
      header: label,
      className: "w-28 text-center",
      cell: (movie: AdminMovie) => (
        <input
          type="checkbox"
          className="size-5 accent-primary"
          aria-label={`${label}: ${movie.title}`}
          checked={Boolean(movie[flag])}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate({ id: movie.id, flags: { [flag]: event.target.checked } })
          }
        />
      ),
    })),
  ];

  const total = page.data?.total ?? 0;
  return (
    <section aria-label="Library" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-60 flex-1 flex-col gap-2">
          <Label htmlFor="library-search">Search titles</Label>
          <Input
            id="library-search"
            type="search"
            className="h-10"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="library-filter">Show</Label>
          <select
            id="library-filter"
            className="h-10 rounded-lg border border-input bg-background px-2"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
              setOffset(0);
            }}
          >
            <option value="all">All titles</option>
            <option value="owned">Owned</option>
            <option value="not_owned">Not owned</option>
            <option value="watchlist">Watchlist</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
      </div>

      <ApiErrorNotice error={update.error} />
      {page.isError ? (
        <AdminQueryError error={page.error} />
      ) : page.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading the library…
        </p>
      ) : (
        <>
          <div data-testid="library-table">
            <DataTable
              caption={`Titles (${total})`}
              columns={columns}
              rows={page.data.items}
              rowKey={(movie) => movie.id}
              empty={
                search || filter !== "all"
                  ? "No titles match. Try another search or show all titles."
                  : "No titles yet. Add the movies you own and they show up here."
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4 text-muted-foreground">
            <span aria-live="polite">
              {total === 0
                ? "0 titles"
                : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
            </span>
            <span className="flex gap-2">
              <Button
                variant="secondary"
                size="lg"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="lg"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
