"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Button } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { AdminQueryError } from "../admin-error";
import { type Account, api, type ApiError, type Night, type NightSummary } from "@/lib/api";

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
  const me = useQuery<Account, ApiError>({ queryKey: ["me"], queryFn: api.me });
  const nights = useQuery<NightSummary[], ApiError>({
    queryKey: ["nights", "history"],
    queryFn: () => api.nights({ limit: 100 }),
  });
  // Correcting a winner is `admin:history`: hide it until the role says admin, so a host never
  // sees a control the API would refuse (owner-portal.md §3.1).
  const canCorrect = me.data?.role === "admin";
  const lede = me.data
    ? canCorrect
      ? "Past nights. Watched something other than the winner? Correct it here; the vote itself is kept."
      : "Past nights and what the family watched."
    : "Past nights.";

  if (nights.isPending) {
    return (
      <HistoryScreen lede={lede}>
        <p role="status" className="text-muted-foreground">
          Loading past nights…
        </p>
      </HistoryScreen>
    );
  }
  if (nights.isError) {
    return (
      <HistoryScreen lede={lede}>
        <AdminQueryError error={nights.error} />
      </HistoryScreen>
    );
  }

  const columns: Column<NightSummary>[] = [
    {
      key: "date",
      header: "Night",
      rowHeader: true,
      cell: (night) => {
        const when = new Date(night.revealed_at ?? night.created_at);
        return (
          <Link
            href={`/host/${night.id}`}
            className="flex flex-col rounded-md underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <time dateTime={when.toISOString()}>{dateFormat.format(when)}</time>
            {night.title ? <span className="text-muted-foreground">{night.title}</span> : null}
          </Link>
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
  ];
  if (canCorrect) {
    columns.push({
      key: "action",
      header: <span className="sr-only">Actions</span>,
      className: "w-44 text-right",
      cell: (night) => (
        <Button
          variant="secondary"
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
    });
  }

  return (
    <HistoryScreen lede={lede}>
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
          empty="No past nights yet. A night shows up here once its winner is revealed."
        />
      </div>
      {editing && canCorrect ? (
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
    </HistoryScreen>
  );
}

function HistoryScreen({ lede, children }: { lede: string; children: React.ReactNode }) {
  return (
    <div data-screen="portal-history" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">History</h1>
        <p className="text-muted-foreground">{lede}</p>
      </header>
      <div className="flex flex-col gap-4">{children}</div>
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
        <Button
          type="submit"
          size="tap"
          data-testid="primary-action"
          disabled={!ready || correct.isPending}
        >
          Confirm correction
        </Button>
        <Button type="button" variant="ghost" size="tap" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
