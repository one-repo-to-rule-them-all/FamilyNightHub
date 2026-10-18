"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorNotice } from "@/components/api-error-notice";
import { GuestShell } from "@/components/home/guest-shell";
import { Avatar } from "@/components/night/avatar";
import { SwitchSheet } from "@/components/night/switch-sheet";
import { PinPad } from "@/components/pin/pin-pad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { PEOPLE_KEY, usePhonePeople } from "@/hooks/use-phone";
import { PERSON_COLORS } from "@/lib/admin";
import {
  api,
  type ApiError,
  type Binding,
  type Person,
  type PersonTile,
  type Profile,
  type Schemas,
} from "@/lib/api";
import { HOME_COPY } from "@/lib/home";
import { PIN_MISMATCH_COPY, PIN_SLOW_COPY, pinFailure, wrongPinCopy } from "@/lib/pin";
import { cn } from "@/lib/utils";
import { cleanGuestName, GUEST_EMOJI, NAME_MAX } from "@/lib/who";

import { profileKey } from "../people/[id]/profile-view";
import { alsoOnPhone, memberSince, meStats, SHARED_LABEL } from "./me";

/**
 * H4 Me (guest-home §5 H4): the current person's picture (changeable any number of times, G10),
 * name (**Change my name** once, while `can_rename`), stats, *This phone* (**Switch person** opens
 * the switch sheet, a PIN on every switch per ADR-0014) and **Change my PIN**. A browse screen: no
 * primary except the shell's live hand-off.
 */
export function MyProfile() {
  const router = useRouter();
  const { people, current, noDevice } = usePhonePeople();
  const nobody = noDevice || (people.isSuccess && !current);

  useEffect(() => {
    if (nobody) router.replace("/");
  }, [nobody, router]);

  return (
    <GuestShell screen="me" back={{ href: "/", label: HOME_COPY.nav.home }}>
      {current && people.data ? <Me person={current} people={people.data} /> : null}
    </GuestShell>
  );
}

function Me({ person, people }: { person: PersonTile; people: PersonTile[] }) {
  const profile = useQuery<Profile, ApiError>({
    queryKey: profileKey(person.id),
    queryFn: () => api.profile(person.id),
  });
  const [picking, setPicking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const others = alsoOnPhone(people);

  return (
    <>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <Avatar emoji={person.avatar_emoji} color={person.color} className="size-24 text-6xl" />
          <button
            type="button"
            aria-label={HOME_COPY.me.picture}
            aria-haspopup="dialog"
            data-testid="change-picture"
            onClick={() => setPicking(true)}
            className="absolute -right-1 -bottom-1 flex size-11 items-center justify-center rounded-full bg-secondary text-secondary-foreground ring-2 ring-background outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <Pencil aria-hidden className="size-5" />
          </button>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h1
            className="truncate font-heading text-3xl font-semibold tracking-tight"
            data-testid="me-name"
          >
            {person.name}
          </h1>
          {profile.data ? (
            <p className="text-muted-foreground">{memberSince(profile.data)}</p>
          ) : null}
        </div>
      </div>
      {picking ? <ChangePicture person={person} onClose={() => setPicking(false)} /> : null}

      <Rename person={person} />

      <section aria-labelledby="me-stats-title" className="flex flex-col gap-3">
        <h2 id="me-stats-title" className="sr-only">
          Stats
        </h2>
        {profile.isError ? (
          <ApiErrorNotice error={profile.error} />
        ) : profile.data ? (
          <dl className="grid grid-cols-2 gap-3" data-testid="profile-stats">
            {meStats(profile.data.stats).map((stat) => (
              <div key={stat.label} className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
                <dt className="text-sm text-muted-foreground">{stat.label}</dt>
                <dd className="tabular text-2xl font-semibold">{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading your stats"
            className="h-40 animate-pulse rounded-2xl bg-muted"
          />
        )}
        <Link
          href="/history?tab=mine"
          data-testid="me-my-nights"
          className="flex min-h-11 items-center self-start text-base font-medium text-cinema underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
        >
          {HOME_COPY.me.myNights}
        </Link>
      </section>

      <section aria-labelledby="me-phone-title" className="flex flex-col gap-3">
        <h2 id="me-phone-title" className="text-xl font-medium">
          {HOME_COPY.me.phone}
        </h2>
        {others.length > 0 ? (
          <p className="text-muted-foreground" data-testid="me-shared">
            {SHARED_LABEL}{" "}
            {others.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? ", " : null}
                <Link
                  href={`/people/${encodeURIComponent(p.id)}?from=me`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {p.name}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
        <Button
          variant="secondary"
          size="tap"
          className="w-full"
          aria-haspopup="dialog"
          data-testid="me-switch"
          onClick={() => setSwitching(true)}
        >
          {HOME_COPY.me.switch}
        </Button>
        <Link
          href="/who"
          data-testid="me-add"
          className="flex min-h-11 items-center self-start text-base underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          {HOME_COPY.me.add}
        </Link>
      </section>
      {switching ? (
        <SwitchSheet people={people} current={person} onClose={() => setSwitching(false)} />
      ) : null}

      <ChangePin person={person} />

      <Link
        href="/login"
        className="self-center text-sm text-muted-foreground underline underline-offset-4"
      >
        Hosting tonight? Sign in
      </Link>
    </>
  );
}

type PictureChange = Pick<Schemas["UpdateSelfIn"], "avatar_emoji" | "color">;

/**
 * **Change picture** (G10; owner decision §11.3: any number of times). A sheet of the 8 guest
 * emoji and the avatar colours; a tap saves at once (`PATCH /devices/me/people/{id}`) and closes.
 * The rename-once rule never applies here.
 */
function ChangePicture({ person, onClose }: { person: PersonTile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const save = useMutation<Person, ApiError, PictureChange>({
    mutationFn: (body) => api.updateSelf(person.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
      void queryClient.invalidateQueries({ queryKey: profileKey(person.id) });
      onClose();
    },
  });
  const pick = (body: PictureChange) => {
    if (!save.isPending) save.mutate(body);
  };
  const color = person.color.toLowerCase();

  return (
    <ModalDialog title="Pick a picture" onClose={onClose} testId="picture-sheet">
      <fieldset className="flex flex-col gap-2" disabled={save.isPending}>
        <legend className="sr-only">Picture</legend>
        <div className="grid grid-cols-4 gap-3">
          {GUEST_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-pressed={person.avatar_emoji === emoji}
              aria-label={`Picture ${emoji}`}
              onClick={() => pick({ avatar_emoji: emoji })}
              className={cn(
                "flex h-16 items-center justify-center rounded-2xl bg-card text-4xl ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring",
                person.avatar_emoji === emoji && "ring-3 ring-foreground",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2" disabled={save.isPending}>
        <legend className="mb-2 text-base font-medium">Colour</legend>
        <div className="grid grid-cols-4 gap-3">
          {PERSON_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={color === c.value}
              aria-label={`Colour ${c.name}`}
              onClick={() => pick({ color: c.value })}
              className={cn(
                "flex h-14 items-center justify-center rounded-2xl ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring",
                color === c.value && "ring-3 ring-foreground",
              )}
            >
              <Avatar emoji={person.avatar_emoji} color={c.value} className="size-11 text-2xl" />
            </button>
          ))}
        </div>
      </fieldset>
      <ApiErrorNotice error={save.error} />
      <Button variant="ghost" size="tap" onClick={onClose}>
        Close
      </Button>
    </ModalDialog>
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
      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          size="tap"
          className="w-full"
          data-testid="me-rename"
          onClick={() => setOpen(true)}
        >
          Change my name
        </Button>
        <p className="text-sm text-muted-foreground">{HOME_COPY.me.renameHelp}</p>
      </div>
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
      <p className="text-sm text-muted-foreground">{HOME_COPY.me.renameHelp}</p>
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
        data-testid="me-pin"
        onClick={() => {
          reset();
          setDone(false);
          setOpen(true);
        }}
      >
        {HOME_COPY.me.pin}
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
