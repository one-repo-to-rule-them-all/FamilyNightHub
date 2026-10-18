"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { PinSheet } from "@/components/pin/pin-sheet";
import { LockedState, ResetPendingState } from "@/components/pin/pin-states";
import { Button, buttonVariants } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { PEOPLE_KEY } from "@/hooks/use-phone";
import { api, type ApiError, type PersonTile } from "@/lib/api";
import { PIN_SLOW_COPY } from "@/lib/pin";
import { phonePeople, tileAction } from "@/lib/who";
import { cn } from "@/lib/utils";

type Step =
  | { kind: "list"; notice?: string }
  | { kind: "pin"; personId: string }
  | { kind: "locked"; personId: string }
  | { kind: "reset"; personId: string };

/**
 * The shared-phone switch sheet (guest-flow spec §5 "Switch sheet"; ADR-0014 "one current
 * person per phone"). Every switch asks for that person's PIN (owner decision §10.3). A wrong
 * PIN, a lock or the per-phone budget never changes who is current: the server only moves
 * `current` on the right PIN, and every way back here keeps the current person.
 */
export function SwitchSheet({
  people,
  current,
  votedIds,
  onClose,
}: {
  people: PersonTile[];
  current: PersonTile;
  /** While voting: who on this phone has a ballot in ("Voted ✓"). */
  votedIds?: ReadonlySet<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useMutation<void, ApiError, string>({
    mutationFn: api.releasePerson,
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
    },
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
  const held = phonePeople(people);
  const byId = (id: string) => people.find((p) => p.id === id);

  const backTo = (
    <Button
      variant="secondary"
      size="tap"
      className="w-full"
      onClick={() => {
        refresh();
        onClose();
      }}
    >
      Back to {current.name}
    </Button>
  );

  if (step.kind === "pin") {
    const person = byId(step.personId);
    if (!person) return null;
    return (
      <PinSheet
        person={person}
        mode="switch"
        currentName={current.name}
        onOutcome={(outcome) => {
          refresh();
          if (outcome === "done") onClose();
          else if (outcome === "locked") setStep({ kind: "locked", personId: person.id });
          else if (outcome === "reset-asked") setStep({ kind: "reset", personId: person.id });
          else if (outcome === "slow") setStep({ kind: "list", notice: PIN_SLOW_COPY });
        }}
        onClose={() => setStep({ kind: "list" })}
      />
    );
  }

  if (step.kind === "locked" || step.kind === "reset") {
    const person = byId(step.personId);
    if (!person) return null;
    return (
      <ModalDialog title="Who's voting now?" onClose={onClose} testId="switch-sheet">
        {step.kind === "locked" ? (
          <LockedState
            person={person}
            onAsked={() => {
              refresh();
              setStep({ kind: "reset", personId: person.id });
            }}
            wayOut={backTo}
          />
        ) : (
          <ResetPendingState person={person} wayOut={backTo} />
        )}
      </ModalDialog>
    );
  }

  return (
    <ModalDialog title="Who's voting now?" onClose={onClose} testId="switch-sheet">
      <div data-screen="switch" className="flex flex-col gap-4">
        {step.notice ? (
          <p role="status" className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            {step.notice}
          </p>
        ) : null}
        <ul className="grid grid-cols-2 gap-3" data-testid="primary-action" aria-label="This phone">
          {held.map((person) => {
            const isCurrent = person.id === current.id;
            const action = tileAction(person);
            const voted = votedIds?.has(person.id);
            return (
              <li key={person.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  disabled={isCurrent}
                  data-current={isCurrent || undefined}
                  onClick={() => {
                    if (action === "locked") setStep({ kind: "locked", personId: person.id });
                    else if (action === "reset-pending")
                      setStep({ kind: "reset", personId: person.id });
                    else setStep({ kind: "pin", personId: person.id });
                  }}
                  className={cn(
                    "flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl bg-card p-3 text-center ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring active:scale-[0.98] disabled:active:scale-100",
                    isCurrent && "marquee-glow",
                  )}
                >
                  <Avatar
                    emoji={person.avatar_emoji}
                    color={person.color}
                    className="size-16 text-4xl"
                  />
                  <span className="text-lg leading-tight font-medium">{person.name}</span>
                  {isCurrent ? (
                    <span className="flex items-center gap-1 text-sm text-cinema">
                      <Check aria-hidden className="size-4" />
                      That&apos;s you
                    </span>
                  ) : person.locked ? (
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Lock aria-hidden className="size-4" />
                      Locked
                    </span>
                  ) : voted ? (
                    <span className="text-sm text-muted-foreground">Voted ✓</span>
                  ) : null}
                </button>
                {!isCurrent ? (
                  removing === person.id ? (
                    <div className="flex flex-col gap-1">
                      <Button
                        variant="destructive"
                        size="lg"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(person.id)}
                      >
                        Remove {person.name}
                      </Button>
                      <Button variant="ghost" size="lg" onClick={() => setRemoving(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="lg" onClick={() => setRemoving(person.id)}>
                      Remove from this phone
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
        <ApiErrorNotice error={remove.error} />
        <Link
          href="/who"
          className={cn(buttonVariants({ variant: "secondary", size: "tap" }), "w-full")}
        >
          <Plus aria-hidden />
          Add someone to this phone
        </Link>
        <Button variant="ghost" size="tap" onClick={onClose}>
          Back to {current.name}
        </Button>
      </div>
    </ModalDialog>
  );
}

/** `copy.chip`: "Voting as **RooDog** · Switch", on every night screen. */
export function CurrentChip({
  current,
  people,
  votedIds,
  verb = "Voting as",
  open: openProp,
  onOpenChange,
}: {
  current: PersonTile;
  people: PersonTile[];
  votedIds?: ReadonlySet<string>;
  verb?: string;
  /**
   * Controlled open state, for a screen that renders the chip in more than one branch (the
   * ballot's loading and loaded views): a tap while loading must survive the switch of branch.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="current-chip"
        className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-card px-3 text-left text-lg ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        <Avatar emoji={current.avatar_emoji} color={current.color} className="size-10 text-2xl" />
        <span className="flex-1">
          {verb} <strong data-testid="voting-as">{current.name}</strong>
        </span>
        <span className="text-base text-muted-foreground underline underline-offset-4">Switch</span>
      </button>
      {open ? (
        <SwitchSheet
          people={people}
          current={current}
          votedIds={votedIds}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
