"use client";

import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { Avatar } from "@/components/night/avatar";
import { PinPad } from "@/components/pin/pin-pad";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { api, type ApiError, type PersonTile } from "@/lib/api";
import { PIN_MISMATCH_COPY, PIN_SLOW_COPY, pinFailure, wrongPinCopy } from "@/lib/pin";

/**
 * The PIN sheet (guest-flow spec §5 S3): one component, four states.
 * - `enter` (S3e): type their PIN to claim them on this phone;
 * - `switch` (S3s): the same, from the switch sheet; the current person stays until it's right;
 * - `create` (S3c): choose a first PIN, then type it again.
 *
 * Every outcome is the caller's to route: `done` back to the resolver, `locked` to S5,
 * `reset-asked` to S6, `asked-host` to S4, `slow` (the per-phone budget) back where it came from.
 */
export type PinSheetMode = "enter" | "switch" | "create";
export type PinOutcome = "done" | "locked" | "reset-asked" | "asked-host" | "slow";

/** Wrong PINs before "Ask the host" is offered on S3e (the ADR-0014 admin override). */
const ASK_HOST_AFTER = 2;

export function PinSheet({
  person,
  mode,
  currentName,
  submit,
  onOutcome,
  onClose,
  onRefused,
  offerRename = false,
}: {
  person: Pick<PersonTile, "id" | "name" | "avatar_emoji" | "color"> & Partial<PersonTile>;
  mode: PinSheetMode;
  /** The person still current on this phone, for `switch`. */
  currentName?: string;
  /** Sends the PIN; the default claims or switches to `person` with it. */
  submit?: (pin: string) => Promise<unknown>;
  onOutcome: (outcome: PinOutcome, options?: { rename?: boolean }) => void;
  onClose: () => void;
  /** A refusal the sheet doesn't own (a name clash on self-create). Return true if handled. */
  onRefused?: (error: ApiError) => boolean;
  /** S3c on a first claim: the quiet "Not your name? Change it" link. */
  offerRename?: boolean;
}) {
  const [first, setFirst] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [wrongs, setWrongs] = useState(0);
  const [slow, setSlow] = useState(false);
  const [rename, setRename] = useState(false);

  const send = useMutation<unknown, ApiError, string>({
    mutationFn: (pin) => (submit ? submit(pin) : api.claimPerson(person.id, pin)),
    onSuccess: () => onOutcome("done", { rename }),
    onError: (error) => {
      if (onRefused?.(error)) return;
      const failure = pinFailure(error);
      setAttempt((n) => n + 1);
      if (failure.kind === "locked") return onOutcome("locked");
      if (failure.kind === "slow") {
        setSlow(true);
        setMessage(PIN_SLOW_COPY);
        if (mode === "switch") onOutcome("slow");
        return;
      }
      if (failure.kind === "wrong") {
        setWrongs((n) => n + 1);
        setMessage(wrongPinCopy(failure.attemptsLeft, person.name));
        return;
      }
      setFirst(null);
      setMessage(null);
    },
  });
  const forgot = useMutation<unknown, ApiError>({
    mutationFn: () => api.forgotPin(person.id),
    onSuccess: () => onOutcome("reset-asked"),
  });
  const askHost = useMutation<unknown, ApiError>({
    mutationFn: () => api.claimPerson(person.id),
    onSuccess: () => onOutcome("asked-host"),
  });

  const creating = mode === "create";
  const confirming = creating && first !== null;
  const screen = creating ? "pin-create" : mode === "switch" ? "pin-switch" : "pin-enter";

  const title = creating ? (
    confirming ? (
      "Type it again"
    ) : (
      <>
        Pick a 6-digit PIN for <strong>{person.name}</strong>
      </>
    )
  ) : mode === "switch" ? (
    <>
      Switch to <strong>{person.name}</strong>? Type their PIN.
    </>
  ) : (
    <>
      Hi <strong>{person.name}</strong>! Type your PIN.
    </>
  );

  const onComplete = (pin: string) => {
    if (!creating) {
      setMessage(null);
      send.mutate(pin);
      return;
    }
    if (first === null) {
      setFirst(pin);
      setMessage(null);
      setAttempt((n) => n + 1);
      return;
    }
    if (pin !== first) {
      setFirst(null);
      setMessage(PIN_MISMATCH_COPY);
      setAttempt((n) => n + 1);
      return;
    }
    send.mutate(pin);
  };

  const other = send.error && pinFailure(send.error).kind === "other" ? send.error : null;

  return (
    <ModalDialog
      title={
        <span className="flex items-center gap-3 pr-10">
          <Avatar emoji={person.avatar_emoji} color={person.color} className="size-12 text-3xl" />
          <span>{title}</span>
        </span>
      }
      onClose={onClose}
      testId="pin-sheet"
    >
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4"
      >
        <X aria-hidden />
      </Button>
      <div data-screen={screen} className="flex flex-col items-center gap-4">
        {mode === "switch" && currentName ? (
          <p className="text-center text-muted-foreground" data-testid="still-current">
            Still set to <strong className="text-foreground">{currentName}</strong> until the PIN is
            right.
          </p>
        ) : null}
        {creating && !confirming ? (
          <p className="text-center text-muted-foreground">
            You&apos;ll need it if you use another phone. Grown-ups pick it for kids.
          </p>
        ) : null}

        <div data-testid="primary-action" className="w-full">
          <PinPad
            key={confirming ? "confirm" : "first"}
            label={creating ? (confirming ? "Type the PIN again" : "New PIN") : "PIN"}
            onComplete={onComplete}
            busy={send.isPending}
            disabled={slow}
            attempt={attempt}
          />
        </div>

        <p
          aria-live="polite"
          className="min-h-6 text-center text-lg font-medium empty:min-h-0"
          data-testid="pin-message"
        >
          {message}
        </p>
        <ApiErrorNotice error={other ?? forgot.error ?? askHost.error} />
        <p className="text-center text-sm text-muted-foreground">Grown-ups can type it for kids.</p>

        <div className="flex flex-col items-center gap-1">
          {!creating ? (
            <Button
              variant="link"
              size="tap"
              disabled={forgot.isPending}
              onClick={() => forgot.mutate()}
            >
              Forgot PIN?
            </Button>
          ) : null}
          {mode === "enter" && wrongs >= ASK_HOST_AFTER && person.binding !== "mine" ? (
            <Button
              variant="link"
              size="tap"
              disabled={askHost.isPending}
              onClick={() => askHost.mutate()}
            >
              Ask the host to let this phone in
            </Button>
          ) : null}
          {creating && offerRename ? (
            <Button
              variant="link"
              size="tap"
              aria-pressed={rename}
              onClick={() => setRename((r) => !r)}
            >
              {rename ? "OK, you'll change your name next" : "Not your name? Change it"}
            </Button>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
}
