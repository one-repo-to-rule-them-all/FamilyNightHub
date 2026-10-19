"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hourglass, Lock, Plus, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { PhoneScreen } from "@/components/phone-screen";
import { PinSheet, type PinOutcome } from "@/components/pin/pin-sheet";
import { LockedState, ResetPendingState, WaitingForHostState } from "@/components/pin/pin-states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiError, type PersonTile } from "@/lib/api";
import { POLL_MS } from "@/lib/live";
import {
  canFollow,
  cleanGuestName,
  colorFor,
  followWaiting,
  GUEST_EMOJI,
  NAME_MAX,
  orderTiles,
  tileAction,
  tileBadge,
  waitingPollInterval,
  type WaitingNotice,
} from "@/lib/who";
import { cn } from "@/lib/utils";

const PEOPLE = ["people"] as const;

type View =
  | { kind: "done" }
  | { kind: "grid"; notice?: React.ReactNode; highlight?: string }
  | { kind: "pin"; personId: string; mode: "enter" | "create"; notice?: React.ReactNode }
  // `since`: when this phone asked (Date.now()); unset when the tile was already waiting.
  // `seen`: this wait has seen the claim pending on the server, so leaving it is an answer.
  | { kind: "pending"; personId: string; since?: number; seen?: boolean }
  | { kind: "locked"; personId: string; notice?: React.ReactNode }
  | { kind: "reset"; personId: string; since?: number }
  | { kind: "new"; name: string; emoji: string | null; taken?: string; slow?: boolean }
  | { kind: "new-pin"; name: string; emoji: string };

/**
 * /who, "Who's watching?" (guest-flow spec §5 S2–S7): the avatar grid and every PIN state
 * reached from it. A successful claim goes back to the resolver (`/`), which lands the phone on
 * the night. Waiting states (S4, S6) poll the people list and move on by themselves (gap G5).
 */
export function WhoGrid() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: "grid" });
  const waiting = view.kind === "pending" || view.kind === "reset";
  const people = useQuery<PersonTile[], ApiError>({
    queryKey: PEOPLE,
    queryFn: api.people,
    refetchInterval: (query) => (waiting ? POLL_MS : waitingPollInterval(query.state.data)),
    refetchOnWindowFocus: true,
  });
  const signedOut = people.error?.status === 401;

  const leave = signedOut || view.kind === "done";
  useEffect(() => {
    // No device: the resolver shows the join screen (or "Scan the QR") instead of a dead end.
    // An approved claim: the resolver lands the phone on the night.
    if (leave) router.replace("/?arrive=1");
  }, [leave, router]);

  const tiles = people.data ?? [];
  const byId = (id: string) => tiles.find((p) => p.id === id);

  // Waiting screens follow the server (adjusting state during render, not in an effect).
  const since = view.kind === "pending" || view.kind === "reset" ? view.since : undefined;
  const next =
    people.data && waiting && canFollow(since, people.dataUpdatedAt)
      ? followServer(view, byId)
      : null;
  if (next) setView(next);

  const finish = (outcome: PinOutcome, personId: string, options?: { rename?: boolean }) => {
    void queryClient.invalidateQueries({ queryKey: PEOPLE });
    if (outcome === "done") router.replace(options?.rename ? "/me?rename=1" : "/?arrive=1");
    else if (outcome === "locked") setView({ kind: "locked", personId });
    else if (outcome === "reset-asked") setView({ kind: "reset", personId, since: Date.now() });
    else if (outcome === "asked-host") setView({ kind: "pending", personId, since: Date.now() });
  };

  // A held person with no PIN: the claim itself asks the host (ADR-0014 host override), so it is
  // sent before the waiting screen opens. Its refusal is shown as-is, never as "the host said no".
  const askHost = useMutation<unknown, ApiError, string>({
    mutationFn: (personId) => api.claimPerson(personId),
    onSuccess: (_, personId) => finish("asked-host", personId),
    onError: () => void queryClient.invalidateQueries({ queryKey: PEOPLE }),
  });

  const pickElse = (
    <Button
      variant="secondary"
      size="tap"
      className="w-full"
      onClick={() => setView({ kind: "grid" })}
    >
      Pick someone else
    </Button>
  );

  if (people.isPending || leave) {
    return (
      <PhoneScreen title="Who's watching?">
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading people"
          className="grid grid-cols-2 gap-3"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      </PhoneScreen>
    );
  }
  if (people.isError) {
    return (
      <PhoneScreen title="Who's watching?">
        <ApiErrorNotice error={people.error} />
      </PhoneScreen>
    );
  }

  if (view.kind === "pending" || view.kind === "locked" || view.kind === "reset") {
    const person = byId(view.personId);
    if (!person) return null;
    return (
      <PhoneScreen title="Movie night">
        {view.kind === "pending" ? (
          <WaitingForHostState person={person} wayOut={pickElse} />
        ) : view.kind === "reset" ? (
          <ResetPendingState person={person} wayOut={pickElse} />
        ) : (
          <LockedState
            person={person}
            notice={view.notice}
            onAsked={() => finish("reset-asked", person.id)}
            onBack={() => setView({ kind: "grid" })}
          />
        )}
      </PhoneScreen>
    );
  }

  if (view.kind === "new") {
    return (
      <NewGuest
        view={view}
        onChange={setView}
        onNext={(name, emoji) => setView({ kind: "new-pin", name, emoji })}
        onThatsMe={(personId) => setView({ kind: "grid", highlight: personId })}
        pickElse={pickElse}
        people={tiles}
      />
    );
  }

  const pinPerson = view.kind === "pin" ? byId(view.personId) : undefined;

  return (
    <PhoneScreen title="Who's watching?" lede="Tap your picture.">
      <div data-screen="who" className="flex flex-col gap-5">
        {(view.kind === "grid" || view.kind === "pin") && view.notice ? (
          <p role="status" className="rounded-xl bg-card p-4 text-base ring-1 ring-foreground/10">
            {view.notice}
          </p>
        ) : null}
        <ApiErrorNotice error={askHost.error} />
        {tiles.length === 0 ? (
          <p className="text-lg text-muted-foreground">
            No one&apos;s here yet. Tap{" "}
            <strong className="text-foreground">I&apos;m new here</strong> to add yourself.
          </p>
        ) : null}
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          data-testid="primary-action"
          aria-label="People"
        >
          {orderTiles(tiles).map((person) => (
            <li key={person.id}>
              <Tile
                person={person}
                highlight={view.kind === "grid" && view.highlight === person.id}
                onTap={() =>
                  tileAction(person) === "ask-host"
                    ? askHost.mutate(person.id)
                    : setView(tapTarget(person))
                }
                onCurrent={() => router.replace("/?arrive=1")}
              />
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setView({ kind: "new", name: "", emoji: null })}
              className={cn(
                TILE_CLASS,
                "border-2 border-dashed border-foreground/20 bg-transparent ring-0",
              )}
            >
              <span
                aria-hidden
                className="flex size-20 items-center justify-center rounded-full bg-secondary"
              >
                <Plus className="size-9" />
              </span>
              <span className="text-lg leading-tight font-medium">I&apos;m new here</span>
            </button>
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          <Link href="/login" className="text-foreground underline underline-offset-4">
            Hosting tonight? Sign in
          </Link>
        </p>
      </div>

      {view.kind === "pin" && pinPerson ? (
        <PinSheet
          person={pinPerson}
          mode={view.mode}
          // People bound before ADR-0014 set their first PIN on the phone that holds them.
          submit={
            view.mode === "create" && pinPerson.binding === "mine"
              ? (pin) => api.setPin(pinPerson.id, { new_pin: pin })
              : undefined
          }
          offerRename={
            view.mode === "create" && pinPerson.binding !== "mine" && pinPerson.can_rename
          }
          onOutcome={(outcome, options) => finish(outcome, pinPerson.id, options)}
          onClose={() => setView({ kind: "grid" })}
        />
      ) : null}
      {view.kind === "new-pin" ? (
        <PinSheet
          person={{
            id: "new",
            name: view.name,
            avatar_emoji: view.emoji,
            color: colorFor(view.name),
          }}
          mode="create"
          submit={(pin) =>
            api.createSelf({
              name: view.name,
              avatar_emoji: view.emoji,
              color: colorFor(view.name),
              pin,
            })
          }
          onRefused={(error) => {
            if (error.status === 409) {
              setView({ kind: "new", name: view.name, emoji: view.emoji, taken: view.name });
              return true;
            }
            if (error.status === 429) {
              setView({ kind: "new", name: view.name, emoji: view.emoji, slow: true });
              return true;
            }
            return false;
          }}
          onOutcome={(outcome) => finish(outcome, "new")}
          onClose={() => setView({ kind: "new", name: view.name, emoji: view.emoji })}
        />
      ) : null}
    </PhoneScreen>
  );
}

/** Where a tile tap goes (spec §5 S2 table). */
function tapTarget(person: PersonTile): View {
  switch (tileAction(person)) {
    case "current":
      return { kind: "grid" };
    case "enter":
      return { kind: "pin", personId: person.id, mode: "enter" };
    case "create":
      return { kind: "pin", personId: person.id, mode: "create" };
    case "ask-host":
      // Not reached: WhoGrid sends the claim first (askHost), then opens the waiting screen.
      return { kind: "grid" };
    case "pending":
      return { kind: "pending", personId: person.id, seen: true };
    case "locked":
      return { kind: "locked", personId: person.id };
    case "reset-pending":
      return { kind: "reset", personId: person.id };
  }
}

/** A waiting screen's next view, with the notice's words (spec §7 copy deck). */
function followServer(view: View, byId: (id: string) => PersonTile | undefined): View | null {
  if (view.kind !== "pending" && view.kind !== "reset") return null;
  const person = byId(view.personId);
  if (view.kind === "pending" && !view.seen && person?.binding === "pending") {
    return { ...view, seen: true };
  }
  const next = followWaiting(view.kind, person, view.kind === "pending" ? !!view.seen : true);
  if (!next) return null;
  if (next.kind === "done") return next;
  const notice = person && next.notice ? noticeCopy(next.notice, person.name) : undefined;
  if (next.kind === "grid" || !person) return { kind: "grid", notice };
  if (next.kind === "locked") return { kind: "locked", personId: person.id, notice };
  return { kind: "pin", personId: person.id, mode: next.mode, notice };
}

function noticeCopy(notice: WaitingNotice, name: string): React.ReactNode {
  switch (notice) {
    case "rejected":
      return (
        <>
          The host said no for <strong>{name}</strong> on this phone. Pick who you are.
        </>
      );
    case "not-waiting":
      return (
        <>
          <strong>{name}</strong> isn&apos;t waiting for the host on this phone. Tap them to ask
          again.
        </>
      );
    case "dismissed":
      return (
        <>
          The family admin didn&apos;t reset <strong>{name}</strong>&apos;s PIN this time. Ask them
          in person.
        </>
      );
    case "other-phone":
      return (
        <>
          <strong>{name}</strong>&apos;s PIN was reset on another phone. Type the new PIN, or ask
          whoever set it.
        </>
      );
  }
}

const TILE_CLASS =
  "flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl bg-card p-3 text-center ring-1 ring-foreground/10 transition-transform outline-none focus-visible:ring-3 focus-visible:ring-ring active:scale-[0.98]";

function Tile({
  person,
  highlight,
  onTap,
  onCurrent,
}: {
  person: PersonTile;
  highlight: boolean;
  onTap: () => void;
  onCurrent: () => void;
}) {
  const action = tileAction(person);
  const badge = tileBadge(person);
  const icon =
    action === "current" ? (
      <Check aria-hidden className="size-4" />
    ) : person.locked ? (
      <Lock aria-hidden className="size-4" />
    ) : person.binding === "pending" ? (
      <Hourglass aria-hidden className="size-4" />
    ) : person.binding === "taken" ? (
      <Smartphone aria-hidden className="size-4" />
    ) : null;
  return (
    <button
      type="button"
      data-binding={person.binding}
      data-action={action}
      autoFocus={highlight}
      onClick={action === "current" ? onCurrent : onTap}
      className={cn(
        TILE_CLASS,
        action === "current" && "marquee-glow",
        highlight && "ring-3 ring-foreground",
      )}
    >
      <Avatar emoji={person.avatar_emoji} color={person.color} className="size-20 text-5xl" />
      <span className="text-lg leading-tight font-medium">{person.name}</span>
      {badge ? (
        <span
          className={cn(
            "flex items-center gap-1 text-sm",
            action === "current" ? "text-cinema" : "text-muted-foreground",
          )}
        >
          {icon}
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/** S7: a new guest names themself and picks a picture; the PIN comes next (S3c). */
function NewGuest({
  view,
  people,
  onChange,
  onNext,
  onThatsMe,
  pickElse,
}: {
  view: Extract<View, { kind: "new" }>;
  people: PersonTile[];
  onChange: (view: View) => void;
  onNext: (name: string, emoji: string) => void;
  onThatsMe: (personId: string) => void;
  pickElse: React.ReactNode;
}) {
  const name = cleanGuestName(view.name);
  const ready = name !== null && view.emoji !== null;
  const clash = view.taken
    ? people.find((p) => p.name.toLowerCase() === view.taken!.toLowerCase())
    : undefined;

  return (
    <PhoneScreen title="Welcome! What should we call you?">
      <form
        data-screen="new-guest"
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onNext(name, view.emoji!);
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="guest-name" className="text-base">
            Name
          </Label>
          <Input
            id="guest-name"
            value={view.name}
            maxLength={NAME_MAX}
            autoCapitalize="words"
            autoComplete="off"
            autoFocus
            onChange={(event) =>
              onChange({ kind: "new", name: event.target.value, emoji: view.emoji })
            }
            className="h-14 text-xl md:text-xl"
          />
        </div>

        {view.taken ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
          >
            <p>
              There&apos;s already a <strong>{view.taken}</strong> here. Is that you?
            </p>
            {clash ? (
              <Button variant="secondary" size="tap" onClick={() => onThatsMe(clash.id)}>
                That&apos;s me
              </Button>
            ) : null}
          </div>
        ) : null}
        {view.slow ? (
          <p role="alert" className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            This phone has added a lot of people. Ask the host to add you.
          </p>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-base font-medium">Pick a picture</legend>
          <div className="grid grid-cols-4 gap-3">
            {GUEST_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-pressed={view.emoji === emoji}
                aria-label={`Picture ${emoji}`}
                onClick={() => onChange({ kind: "new", name: view.name, emoji })}
                className={cn(
                  "flex h-16 items-center justify-center rounded-2xl bg-card text-4xl ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  view.emoji === emoji && "ring-3 ring-foreground",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </fieldset>

        <Button
          type="submit"
          size="tap"
          className="w-full"
          disabled={!ready || view.slow}
          data-testid="primary-action"
        >
          Next
        </Button>
        {pickElse}
      </form>
    </PhoneScreen>
  );
}
