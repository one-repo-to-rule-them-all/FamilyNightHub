"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  PEOPLE_FILTERS,
  PERSON_STATUS_LABEL,
  type PeopleFilter,
  type PersonDraft,
  attentionLine,
  describeMerge,
  filterPeople,
  needsAttention,
  peopleSummary,
  personChanges,
  personIdFromHash,
  personStatus,
} from "@/lib/admin";
import { type AdminPerson, type ApiError, type MergeResult, api } from "@/lib/api";
import { cn } from "@/lib/utils";

import { AdminQueryError } from "../admin-error";
import { PersonForm } from "./person-form";
import { PinRequests } from "./pin-requests";

const PEOPLE_KEY = ["admin", "people"] as const;

/** `copy.people.empty` (owner-portal spec §9). */
const PEOPLE_EMPTY = "No one yet. Add the family, or let guests add themselves when they join.";

const SELECT_CLASS =
  "h-11 w-full rounded-lg border border-input bg-input/30 px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The URL hash; Home's inbox links here as `#person-{id}` (AC-P4.2). */
function useHash() {
  return useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
}

/**
 * People (owner-portal spec §5 P3, `data-screen="portal-people"`): "Add a person" is the one
 * primary, open PIN requests sit on top (hidden when there are none), and the table shows each
 * person's PIN status with an All · Family · Guests · Needs attention filter.
 */
export function PeopleAdmin() {
  const people = useQuery<AdminPerson[], ApiError>({
    queryKey: PEOPLE_KEY,
    queryFn: api.adminPeople,
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminPerson | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (people.isError) return <AdminQueryError error={people.error} />;

  return (
    <div data-screen="portal-people" className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">People</h1>
          {people.data ? (
            <p className="text-sm text-muted-foreground">{peopleSummary(people.data)}</p>
          ) : null}
        </div>
        <Button
          size="lg"
          className="px-4"
          data-testid="primary-action"
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden />
          Add a person
        </Button>
      </header>
      <p aria-live="polite" data-testid="people-notice" className="empty:hidden">
        {notice}
      </p>
      <PinRequests onNotice={setNotice} />
      {people.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading people…
        </p>
      ) : (
        <>
          <PeopleTable
            people={people.data}
            onEdit={setEditing}
            onConverted={(p) => setNotice(`${p.name} is family now.`)}
          />
          {people.data.length > 1 ? (
            <MergePeople people={people.data} onMerged={setNotice} />
          ) : null}
        </>
      )}
      {adding ? (
        <AddPerson
          onClose={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false);
            setNotice(`Added ${p.name}.`);
          }}
        />
      ) : null}
      {editing ? (
        <EditPerson
          person={editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) setNotice(`Saved ${saved.name}.`);
          }}
        />
      ) : null}
    </div>
  );
}

function AddPerson({
  onAdded,
  onClose,
}: {
  onAdded: (person: AdminPerson) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation<AdminPerson, ApiError, { draft: PersonDraft; isGuest: boolean }>({
    mutationFn: ({ draft, isGuest }) =>
      api.createPerson({
        name: draft.name,
        avatar_emoji: draft.avatarEmoji.trim(),
        color: draft.color,
        is_guest: isGuest,
      }),
    onSuccess: (person) => {
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      onAdded(person);
    },
  });

  return (
    <ModalDialog title="Add a person" onClose={onClose} testId="add-person">
      <PersonForm
        withGuest
        submitLabel="Add person"
        pending={create.isPending}
        onSubmit={(draft, isGuest) => create.mutate({ draft, isGuest })}
      >
        <ApiErrorNotice error={create.error} />
        <Button type="button" variant="ghost" className="self-start" onClick={onClose}>
          Cancel
        </Button>
      </PersonForm>
    </ModalDialog>
  );
}

/** `PIN set`, `No PIN yet` (muted) or a `Locked` chip (spec §5 P3). */
function StatusChip({ person }: { person: AdminPerson }) {
  const status = personStatus(person);
  const label = PERSON_STATUS_LABEL[status];
  if (status === "locked") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        <Lock aria-hidden className="size-3" />
        {label}
      </span>
    );
  }
  return <span className={cn(status === "no-pin" && "text-muted-foreground")}>{label}</span>;
}

function PeopleTable({
  people,
  onEdit,
  onConverted,
}: {
  people: AdminPerson[];
  onEdit: (person: AdminPerson) => void;
  onConverted: (person: AdminPerson) => void;
}) {
  const queryClient = useQueryClient();
  const hash = useHash();
  const [filter, setFilter] = useState<PeopleFilter>("all");
  // The hash a filter click has already moved past: picking a filter drops the inbox's highlight.
  const [seenHash, setSeenHash] = useState<string | null>(null);
  const linked = hash === seenHash ? null : personIdFromHash(hash);
  const target = linked && people.some((p) => p.id === linked) ? linked : null;
  // A linked person is always on screen, whatever the filter was.
  const shown = target ? people : filterPeople(people, filter);
  const attention = people.filter(needsAttention).length;

  useEffect(() => {
    if (!target) return;
    document
      .getElementById(`person-${target}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [target]);

  const convert = useMutation<AdminPerson, ApiError, string>({
    mutationFn: api.convertToMember,
    onSuccess: (person) => {
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      onConverted(person);
    },
  });

  const columns: Column<AdminPerson>[] = [
    {
      key: "person",
      header: "Person",
      rowHeader: true,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <Avatar emoji={p.avatar_emoji} color={p.color} className="size-8 text-lg" />
          <span>{p.name}</span>
        </span>
      ),
    },
    {
      key: "kind",
      header: "Type",
      cell: (p) =>
        p.is_guest ? (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs">Guest</span>
        ) : (
          <span className="text-muted-foreground">Family</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      className: "whitespace-nowrap",
      cell: (p) => <StatusChip person={p} />,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "text-right whitespace-nowrap",
      cell: (p) => (
        <span className="inline-flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => onEdit(p)} aria-label={`Edit ${p.name}`}>
            Edit
          </Button>
          {p.is_guest ? (
            <Button
              variant="outline"
              size="sm"
              disabled={convert.isPending}
              onClick={() => convert.mutate(p.id)}
              aria-label={`Make ${p.name} a family member`}
            >
              Make family member
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <section aria-label="Everyone" className="flex flex-col gap-3">
      <div
        role="group"
        aria-label="Show"
        className="flex flex-wrap gap-2"
        data-testid="people-filter"
      >
        {PEOPLE_FILTERS.map((f) => {
          const pressed = !target && filter === f.key;
          return (
            <Button
              key={f.key}
              variant={pressed ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={pressed}
              className={cn("h-9 px-3", pressed && "ring-1 ring-foreground/20")}
              onClick={() => {
                setFilter(f.key);
                setSeenHash(hash);
              }}
            >
              {f.key === "attention" ? `${f.label} · ${attention}` : f.label}
            </Button>
          );
        })}
      </div>
      {attention > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="attention-line">
          {attentionLine(people)}
        </p>
      ) : null}
      <ApiErrorNotice error={convert.error} />
      <DataTable
        caption={`People (${shown.length})`}
        columns={columns}
        rows={shown}
        rowKey={(p) => p.id}
        rowProps={(p) => ({
          id: `person-${p.id}`,
          "data-person": p.name,
          "data-guest": String(p.is_guest),
          "data-status": personStatus(p),
          ...(p.id === target
            ? {
                "data-highlighted": "true",
                className: "bg-primary/10 ring-2 ring-primary ring-inset",
              }
            : {}),
        })}
        empty={
          people.length === 0
            ? PEOPLE_EMPTY
            : filter === "attention"
              ? "Everyone has a PIN and nobody is locked out."
              : "Nobody here with this filter."
        }
      />
    </section>
  );
}

function EditPerson({
  person,
  onDone,
}: {
  person: AdminPerson;
  onDone: (saved: AdminPerson | null) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation<AdminPerson | null, ApiError, PersonDraft>({
    mutationFn: async (draft) => {
      const changes = personChanges(person, draft);
      return changes ? api.updatePerson(person.id, changes) : null;
    },
    onSuccess: (saved) => {
      if (saved) void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      onDone(saved);
    },
  });

  return (
    <ModalDialog title={`Edit ${person.name}`} onClose={() => onDone(null)} testId="edit-person">
      <PersonForm
        initial={{ name: person.name, avatarEmoji: person.avatar_emoji, color: person.color }}
        submitLabel="Save"
        pending={save.isPending}
        onSubmit={(draft) => save.mutate(draft)}
      >
        <ApiErrorNotice error={save.error} />
        <Button type="button" variant="ghost" className="self-start" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </PersonForm>
    </ModalDialog>
  );
}

function MergePeople({
  people,
  onMerged,
}: {
  people: AdminPerson[];
  onMerged: (message: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [fromId, setFromId] = useState("");
  const [intoId, setIntoId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const from = people.find((p) => p.id === fromId);
  const into = people.find((p) => p.id === intoId);
  const ready = from && into && from.id !== into.id;

  const merge = useMutation<MergeResult, ApiError, { from: AdminPerson; into: AdminPerson }>({
    mutationFn: ({ from: source, into: target }) =>
      api.mergePeople({ from_person_id: source.id, into_person_id: target.id }),
    onSuccess: (result, { from: source, into: target }) => {
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      setConfirming(false);
      setFromId("");
      setIntoId("");
      onMerged(`Merged ${source.name} into ${target.name}. ${describeMerge(result, target.name)}`);
    },
  });

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Merge duplicates
      </h2>
      <p className="text-sm text-muted-foreground">
        Someone added twice? Fold the duplicate into the person to keep.
      </p>
      <div className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-from`}>Duplicate (will be hidden)</Label>
          <select
            id={`${id}-from`}
            value={fromId}
            onChange={(event) => setFromId(event.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.avatar_emoji} {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-into`}>Keep</Label>
          <select
            id={`${id}-into`}
            value={intoId}
            onChange={(event) => setIntoId(event.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">Choose…</option>
            {people
              .filter((p) => p.id !== fromId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.avatar_emoji} {p.name}
                </option>
              ))}
          </select>
        </div>
        <Button
          variant="outline"
          size="lg"
          disabled={!ready}
          onClick={() => {
            merge.reset();
            setConfirming(true);
          }}
          className="px-4"
        >
          Merge…
        </Button>
      </div>

      {confirming && ready ? (
        <ModalDialog
          title={`Merge ${from.name} into ${into.name}?`}
          onClose={() => setConfirming(false)}
          testId="merge-confirm"
        >
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Everything {from.name} has moves to <strong>{into.name}</strong>: ballots, ratings,
              photos, photo reactions and phone bindings.
            </p>
            <p>
              {from.name} is then hidden from every list. Nobody is ever deleted, but there is no
              un-merge here.
            </p>
            <p className="text-muted-foreground">
              Where both voted in the same night, or both rated it, {into.name}&apos;s is kept and{" "}
              {from.name}&apos;s is dropped. {into.name} keeps their own name, avatar and colour.
            </p>
          </div>
          <ApiErrorNotice error={merge.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="lg"
              className="px-4"
              disabled={merge.isPending}
              onClick={() => merge.mutate({ from, into })}
            >
              {merge.isPending ? "Merging…" : `Merge into ${into.name}`}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  );
}
