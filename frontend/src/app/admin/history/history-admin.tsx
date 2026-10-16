"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { AdminQueryError } from "../admin-error";
import { api, type ApiError, type Night, type NightSummary } from "@/lib/api";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const STATUS_LABEL: Record<string, string> = {
  revealed: "Revealed",
  tonight: "Tonight",
  closed: "Closed",
};

export function HistoryAdmin() {
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nights = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "history"],
    queryFn: () => api.nights({ limit: 100 }),
  });

  if (nights.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading past nights…
      </p>
    );
  }
  if (nights.isError) return <AdminQueryError error={nights.error} />;

  const columns: Column<NightSummary>[] = [
    {
      key: "date",
      header: "Night",
      rowHeader: true,
      cell: (night) => {
        const when = new Date(night.revealed_at ?? night.created_at);
        return (
          <span className="flex flex-col">
            <time dateTime={when.toISOString()}>{dateFormat.format(when)}</time>
            {night.title ? <span className="text-muted-foreground">{night.title}</span> : null}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      cell: (night) => STATUS_LABEL[night.status] ?? night.status,
    },
    {
      key: "winner",
      header: "Winner",
      cell: (night) => (
        <span className="font-medium" data-testid="admin-history-winner">
          {night.winner?.title ?? "No winner"}
        </span>
      ),
    },
    {
      key: "action",
      header: <span className="sr-only">Actions</span>,
      className: "w-44 text-right",
      cell: (night) => (
        <Button
          variant="outline"
          size="lg"
          aria-expanded={editing === night.id}
          aria-controls={editing === night.id ? `correct-${night.id}` : undefined}
          onClick={() => {
            setNotice(null);
            setEditing(editing === night.id ? null : night.id);
          }}
        >
          Correct winner
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <p role="status" className="rounded-xl bg-card p-4" data-testid="correction-notice">
          {notice}
        </p>
      ) : null}
      <div data-testid="admin-history-table">
        <DataTable
          caption="Past nights"
          columns={columns}
          rows={nights.data}
          rowKey={(night) => night.id}
          empty="No past nights yet."
        />
      </div>
      {editing ? (
        <CorrectWinner
          key={editing}
          sessionId={editing}
          onDone={(message) => {
            setEditing(null);
            setNotice(message);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function CorrectWinner({
  sessionId,
  onDone,
  onCancel,
}: {
  sessionId: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [optionId, setOptionId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const night = useQuery<Night, ApiError>({
    queryKey: ["night", sessionId],
    queryFn: () => api.night(sessionId),
  });

  const correct = useMutation<Night, ApiError, { option_id: string; reason: string }>({
    mutationFn: (body) => api.correctWinner(sessionId, body),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["night", sessionId], updated);
      await queryClient.invalidateQueries({ queryKey: ["nights"] });
      const winner = updated.options.find((o) => o.id === updated.result?.winner_option_id);
      onDone(`Winner corrected to ${winner?.title ?? "the new pick"}.`);
    },
  });

  if (night.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading the shortlist…
      </p>
    );
  }
  if (night.isError) return <ApiErrorNotice error={night.error} />;

  const winnerId = night.data.result?.winner_option_id;
  const others = night.data.options.filter((o) => o.id !== winnerId);
  const current = night.data.options.find((o) => o.id === winnerId);
  const ready = optionId !== null && reason.trim().length > 0;

  return (
    <form
      id={`correct-${sessionId}`}
      aria-labelledby={`correct-heading-${sessionId}`}
      className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) correct.mutate({ option_id: optionId, reason: reason.trim() });
      }}
    >
      <h2 id={`correct-heading-${sessionId}`} className="text-lg font-semibold">
        Correct the winner{current ? ` (now ${current.title})` : ""}
      </h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base">What did you actually watch?</legend>
        {others.map((option) => (
          <label key={option.id} className="flex items-center gap-3 text-base">
            <input
              type="radio"
              className="size-5 accent-primary"
              name={`winner-${sessionId}`}
              value={option.id}
              checked={optionId === option.id}
              onChange={() => setOptionId(option.id)}
            />
            {option.title}
            {option.year ? ` (${option.year})` : ""}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`reason-${sessionId}`} className="text-base">
          Reason (kept in the audit log)
        </Label>
        <textarea
          id={`reason-${sessionId}`}
          rows={2}
          maxLength={500}
          required
          className="rounded-lg border border-input bg-transparent p-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <ApiErrorNotice error={correct.error} />
      <div className="flex gap-3">
        <Button type="submit" size="tap" disabled={!ready || correct.isPending}>
          Confirm correction
        </Button>
        <Button type="button" variant="ghost" size="tap" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
