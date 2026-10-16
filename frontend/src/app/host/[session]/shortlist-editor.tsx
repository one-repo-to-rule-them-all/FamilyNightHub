"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useEffect, useReducer } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Poster } from "@/components/night/poster";
import { Button } from "@/components/ui/button";
import { nightKey } from "@/hooks/use-night-poll";
import { api, type ApiError, type Night } from "@/lib/api";
import { MAX_OPTIONS, moveOption, shortlistReducer } from "@/lib/shortlist";

/**
 * The shortlist in display order. A move shows at once (local reducer), the PUT sends the whole
 * order, and the server's answer is synced back: on success it is the same order, on failure the
 * last order the server holds.
 */
export function ShortlistEditor({ night }: { night: Night }) {
  const queryClient = useQueryClient();
  const serverIds = night.options.map((o) => o.id);
  const serverKey = serverIds.join(",");
  const [state, dispatch] = useReducer(shortlistReducer, { ids: serverIds });

  useEffect(() => {
    dispatch({ type: "sync", ids: serverKey ? serverKey.split(",") : [] });
  }, [serverKey]);

  const onServer = (next: Night) => queryClient.setQueryData(nightKey(night.id), next);
  const resync = () => dispatch({ type: "sync", ids: serverIds });

  const reorder = useMutation<Night, ApiError, string[]>({
    mutationFn: (ids) => api.reorderOptions(night.id, ids),
    onSuccess: onServer,
    onError: resync,
  });
  const remove = useMutation<Night, ApiError, string>({
    mutationFn: (optionId) => api.removeOption(night.id, optionId),
    onSuccess: onServer,
    onError: resync,
  });

  const byId = new Map(night.options.map((o) => [o.id, o]));
  const options = state.ids.flatMap((id) => byId.get(id) ?? []);
  const busy = reorder.isPending || remove.isPending;

  const move = (id: string, delta: number) => {
    const next = moveOption(state.ids, id, delta);
    if (next === state.ids) return;
    dispatch({ type: "move", id, delta });
    reorder.mutate(next);
  };

  return (
    <section aria-labelledby="shortlist" className="flex flex-col gap-3">
      <h2 id="shortlist" className="text-xl font-semibold">
        Shortlist{" "}
        <span className="text-base font-normal text-muted-foreground" data-testid="shortlist-count">
          {options.length} of {MAX_OPTIONS}
        </span>
      </h2>
      <ApiErrorNotice error={reorder.error ?? remove.error} />
      {options.length === 0 ? (
        <p className="text-muted-foreground">Search for posters or type a title below.</p>
      ) : null}
      <ol className="flex flex-col gap-2" aria-label="Shortlist order">
        {options.map((option, index) => (
          <li
            key={option.id}
            data-testid="shortlist-item"
            className="flex items-center gap-3 rounded-xl bg-card p-2 ring-1 ring-foreground/10"
          >
            <span className="tabular w-6 text-center text-muted-foreground" aria-hidden>
              {index + 1}
            </span>
            <Poster
              title={option.title}
              posterPath={option.poster_path}
              width="w185"
              label={false}
              className="w-12 shrink-0"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="line-clamp-2 text-lg leading-tight font-medium break-words">
                {option.title}
              </span>
              {option.year ? (
                <span className="text-sm text-muted-foreground">{option.year}</span>
              ) : null}
            </span>
            <span className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-12"
                aria-label={`Move ${option.title} up`}
                disabled={busy || index === 0}
                onClick={() => move(option.id, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-12"
                aria-label={`Move ${option.title} down`}
                disabled={busy || index === options.length - 1}
                onClick={() => move(option.id, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-12"
                aria-label={`Remove ${option.title}`}
                disabled={busy}
                onClick={() => {
                  dispatch({ type: "remove", id: option.id });
                  remove.mutate(option.id);
                }}
              >
                <X />
              </Button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
