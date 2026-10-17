"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { PinPad } from "@/components/pin/pin-pad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { PEOPLE_KEY, usePhonePeople } from "@/hooks/use-phone";
import { api, type ApiError, type Binding, type Person, type PersonTile } from "@/lib/api";
import { PIN_MISMATCH_COPY, PIN_SLOW_COPY, pinFailure, wrongPinCopy } from "@/lib/pin";
import { cleanGuestName, NAME_MAX } from "@/lib/who";

import { profileKey, ProfileView } from "../people/[id]/profile-view";

/**
 * /me: the current person's profile (guest-flow spec §5 "Profile"), plus **Change my name**
 * (once, while `can_rename`) and **Change my PIN** (current PIN, then the new one twice).
 */
export function MyProfile() {
  const router = useRouter();
  const { people, current, noDevice } = usePhonePeople();
  const nobody = noDevice || (people.isSuccess && !current);

  useEffect(() => {
    if (nobody) router.replace("/");
  }, [nobody, router]);

  if (!current) return null;
  return (
    <ProfileView personId={current.id}>
      <div className="flex flex-col gap-3">
        <Rename person={current} />
        <ChangePin person={current} />
      </div>
    </ProfileView>
  );
}

function Rename({ person }: { person: PersonTile }) {
  const queryClient = useQueryClient();
  const asked = useSearchParams().get("rename") === "1";
  const [open, setOpen] = useState(asked);
  const [name, setName] = useState(person.name);
  const save = useMutation<Person, ApiError, string>({
    mutationFn: (value) => api.renameSelf(person.id, value),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      void queryClient.invalidateQueries({ queryKey: profileKey(person.id) });
    },
  });
  if (!person.can_rename) return null;
  const clean = cleanGuestName(name);

  if (!open) {
    return (
      <Button variant="secondary" size="tap" className="w-full" onClick={() => setOpen(true)}>
        Change my name
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
      onSubmit={(event) => {
        event.preventDefault();
        if (clean && !save.isPending) save.mutate(clean);
      }}
    >
      <Label htmlFor="new-name" className="text-base">
        Your name
      </Label>
      <Input
        id="new-name"
        value={name}
        maxLength={NAME_MAX}
        autoCapitalize="words"
        autoComplete="off"
        autoFocus
        onChange={(event) => setName(event.target.value)}
        className="h-14 text-xl md:text-xl"
      />
      <p className="text-sm text-muted-foreground">
        You can change it once. After that, ask the family admin.
      </p>
      <ApiErrorNotice error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" size="tap" className="flex-1" disabled={!clean || save.isPending}>
          {save.isPending ? "Saving…" : "Save name"}
        </Button>
        <Button type="button" variant="ghost" size="tap" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type PinStep = "current" | "new" | "confirm";

function ChangePin({ person }: { person: PersonTile }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<PinStep>("current");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState(false);
  const save = useMutation<Binding, ApiError, { current: string; next: string }>({
    mutationFn: ({ current, next }) =>
      api.setPin(person.id, { current_pin: current, new_pin: next }),
    onSuccess: () => {
      setOpen(false);
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
    },
    onError: (error) => {
      const failure = pinFailure(error);
      setAttempt((n) => n + 1);
      setStep("current");
      if (failure.kind === "wrong") setMessage(wrongPinCopy(failure.attemptsLeft, person.name));
      else if (failure.kind === "slow") setMessage(PIN_SLOW_COPY);
      else if (failure.kind === "locked") {
        setMessage(`${person.name} is locked. Only the family admin can reset it.`);
      } else setMessage(failure.error.message);
    },
  });

  const reset = () => {
    setStep("current");
    setCurrentPin("");
    setNewPin("");
    setMessage(null);
    save.reset();
  };

  return (
    <>
      <Button
        variant="secondary"
        size="tap"
        className="w-full"
        onClick={() => {
          reset();
          setDone(false);
          setOpen(true);
        }}
      >
        Change my PIN
      </Button>
      {done ? (
        <p role="status" className="text-sm text-muted-foreground">
          PIN changed.
        </p>
      ) : null}
      {open ? (
        <ModalDialog
          title={
            step === "current"
              ? "Type your PIN now"
              : step === "new"
                ? "Pick a new 6-digit PIN"
                : "Type it again"
          }
          onClose={() => setOpen(false)}
          testId="change-pin"
        >
          <PinPad
            key={step}
            label={
              step === "current" ? "Current PIN" : step === "new" ? "New PIN" : "New PIN again"
            }
            busy={save.isPending}
            attempt={attempt}
            onComplete={(pin) => {
              if (step === "current") {
                setCurrentPin(pin);
                setMessage(null);
                setStep("new");
              } else if (step === "new") {
                setNewPin(pin);
                setStep("confirm");
              } else if (pin !== newPin) {
                setMessage(PIN_MISMATCH_COPY);
                setStep("new");
              } else {
                save.mutate({ current: currentPin, next: pin });
              }
            }}
          />
          <p aria-live="polite" className="min-h-6 text-center text-lg font-medium empty:min-h-0">
            {message}
          </p>
          <Button variant="ghost" size="tap" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </ModalDialog>
      ) : null}
    </>
  );
}
