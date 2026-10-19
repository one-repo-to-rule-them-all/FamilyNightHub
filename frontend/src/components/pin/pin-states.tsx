"use client";

import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, Hourglass, Lock } from "lucide-react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { api, type ApiError, type PersonTile } from "@/lib/api";

type Who = Pick<PersonTile, "id" | "name" | "avatar_emoji" | "color">;

/**
 * The PIN states that aren't a keypad (guest-flow spec §5 S4–S6). Each is one block with a
 * `data-screen`, used full-screen on /who and inside the switch sheet. The way out is the
 * caller's: "Pick someone else" on /who, "Back to {current}" on a switch; the locked state (S5)
 * takes `onBack` and draws its own "Back to everyone" at the top.
 */

/** The locked screen's copy (guest-flow §7 `copy.s5`, owner feedback on #70). */
export const LOCKED_COPY = {
  back: "Back to everyone",
  forgot: "Forgot PIN",
  helper: "We'll ask the family admin to reset it.",
} as const;

/**
 * S5: too many wrong PINs. Only the family admin can reset it (owner decision §10.2). The way back
 * to everyone sits first, above the person, so it is on screen at 360×640 without scrolling; the
 * one primary is **Forgot PIN**, with what it does on the line under it (#70: "Ask the family
 * admin to reset your PIN" wasn't recognised as Forgot PIN).
 */
export function LockedState({
  person,
  notice,
  onAsked,
  onBack,
}: {
  person: Who;
  notice?: React.ReactNode;
  onAsked: () => void;
  /** Back to the list of people: /who's grid, or the switch sheet's list. */
  onBack: () => void;
}) {
  const ask = useMutation<unknown, ApiError>({
    mutationFn: () => api.forgotPin(person.id),
    onSuccess: onAsked,
  });
  return (
    <section data-screen="locked" className="flex flex-col gap-5" aria-labelledby="locked-title">
      <Button
        variant="ghost"
        size="lg"
        className="-ml-2 self-start text-base"
        data-testid="locked-back"
        onClick={onBack}
      >
        <ChevronLeft aria-hidden />
        {LOCKED_COPY.back}
      </Button>
      <StateHeader person={person} icon={<Lock aria-hidden className="size-5" />}>
        <h2 id="locked-title" className="text-2xl font-semibold">
          <strong>{person.name}</strong> is locked
        </h2>
      </StateHeader>
      {notice ? (
        <p role="status" className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          {notice}
        </p>
      ) : null}
      <p className="text-lg text-muted-foreground">
        Too many wrong PINs. Phones already set to {person.name} still work.
      </p>
      <ApiErrorNotice error={ask.error} />
      <div className="flex flex-col gap-2">
        <Button
          size="tap"
          className="w-full"
          data-testid="primary-action"
          aria-describedby="locked-helper"
          disabled={ask.isPending}
          onClick={() => ask.mutate()}
        >
          {LOCKED_COPY.forgot}
        </Button>
        <p id="locked-helper" className="text-center text-base text-muted-foreground">
          {LOCKED_COPY.helper}
        </p>
      </div>
    </section>
  );
}

/** S6: the family admin was asked. Moves on by itself (the caller polls the people list). */
export function ResetPendingState({ person, wayOut }: { person: Who; wayOut: React.ReactNode }) {
  return (
    <section
      data-screen="reset-pending"
      data-testid="waiting"
      className="flex flex-col gap-5"
      aria-labelledby="reset-title"
    >
      <StateHeader person={person} icon={<Hourglass aria-hidden className="size-5" />}>
        <h2 id="reset-title" className="text-2xl font-semibold">
          We asked the family admin
        </h2>
      </StateHeader>
      <p aria-live="polite" className="text-lg text-muted-foreground">
        The family admin will see your request. When they reset your PIN, you&apos;ll pick a new one
        right here.
      </p>
      {wayOut}
    </section>
  );
}

/** S4: a claim waiting for the host. Approval never resets or bypasses a PIN lock. */
export function WaitingForHostState({ person, wayOut }: { person: Who; wayOut: React.ReactNode }) {
  return (
    <section
      data-screen="pending"
      data-testid="waiting"
      className="flex flex-col gap-5"
      aria-labelledby="pending-title"
    >
      <StateHeader person={person} icon={<Hourglass aria-hidden className="size-5" />}>
        <h2 id="pending-title" className="text-2xl font-semibold">
          Waiting for the host
        </h2>
      </StateHeader>
      <p aria-live="polite" className="text-lg text-muted-foreground">
        <strong className="text-foreground">{person.name}</strong> is on another phone. We asked the
        host to OK this phone too. This screen moves on by itself.
      </p>
      {wayOut}
    </section>
  );
}

function StateHeader({
  person,
  icon,
  children,
}: {
  person: Who;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="relative">
        <Avatar emoji={person.avatar_emoji} color={person.color} className="size-16 text-4xl" />
        <span className="absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full bg-card ring-1 ring-foreground/10">
          {icon}
        </span>
      </span>
      {children}
    </div>
  );
}
