"use client";

import { useId, useState } from "react";

import { Avatar } from "@/components/night/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  EMOJI_GROUPS,
  PERSON_COLORS,
  type PersonDraft,
  type PersonErrors,
  colorChoices,
  validatePerson,
} from "@/lib/admin";
import { cn } from "@/lib/utils";

/**
 * Name, emoji avatar and a colour from the avatar palette (`PERSON_COLORS`); `withGuest` adds
 * the guest checkbox (create only: a guest becomes a member through "Make family member").
 * Checks the API's rules before sending; the API's own answer (a 409 name clash) is the caller's.
 */
export function PersonForm({
  initial,
  withGuest = false,
  submitLabel,
  pending,
  onSubmit,
  children,
}: {
  initial?: PersonDraft;
  withGuest?: boolean;
  submitLabel: string;
  pending: boolean;
  onSubmit: (draft: PersonDraft, isGuest: boolean) => void;
  /** Rendered between the fields and the submit button (server errors, a cancel button). */
  children?: React.ReactNode;
}) {
  const id = useId();
  const [draft, setDraft] = useState<PersonDraft>(
    initial ?? { name: "", avatarEmoji: "", color: PERSON_COLORS[0].value },
  );
  const [isGuest, setIsGuest] = useState(false);
  const [errors, setErrors] = useState<PersonErrors>({});
  const colors = colorChoices(initial?.color);
  const set = (patch: Partial<PersonDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const found = validatePerson(draft);
        setErrors(found);
        if (Object.keys(found).length === 0 && !pending) onSubmit(draft, isGuest);
      }}
    >
      <div className="flex items-end gap-3">
        <Avatar
          emoji={draft.avatarEmoji.trim() || "?"}
          color={draft.color}
          className="size-14 shrink-0 text-3xl"
        />
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={draft.name}
            maxLength={80}
            autoComplete="off"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${id}-name-error` : undefined}
            onChange={(event) => set({ name: event.target.value })}
            className="h-11"
          />
          <FieldError id={`${id}-name-error`} message={errors.name} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-emoji`}>Emoji avatar</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${id}-emoji`}
            value={draft.avatarEmoji}
            maxLength={16}
            autoComplete="off"
            aria-invalid={errors.avatarEmoji ? true : undefined}
            aria-describedby={errors.avatarEmoji ? `${id}-emoji-error` : undefined}
            onChange={(event) => set({ avatarEmoji: event.target.value })}
            className="h-11 w-20 text-center text-2xl"
          />
        </div>
        <div role="group" aria-label="Suggested emoji" className="flex flex-col gap-2">
          {EMOJI_GROUPS.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <p aria-hidden className="text-xs font-medium text-muted-foreground">
                {group.name}
              </p>
              <div className="flex flex-wrap gap-1">
                {group.emoji.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`Use ${emoji}`}
                    aria-pressed={draft.avatarEmoji.trim() === emoji}
                    onClick={() => set({ avatarEmoji: emoji })}
                    className="flex size-11 items-center justify-center rounded-lg text-2xl outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-secondary aria-pressed:ring-1 aria-pressed:ring-foreground/40"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <FieldError id={`${id}-emoji-error`} message={errors.avatarEmoji} />
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {colors.map((color) => {
            const checked = draft.color.toLowerCase() === color.value;
            return (
              <label
                key={color.value}
                className={cn(
                  "flex size-11 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-popover has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  checked && "ring-2 ring-foreground",
                )}
                style={{ backgroundColor: color.value }}
              >
                <input
                  type="radio"
                  name={`${id}-color`}
                  value={color.value}
                  checked={checked}
                  onChange={() => set({ color: color.value })}
                  aria-label={color.name}
                  className="sr-only"
                />
              </label>
            );
          })}
        </div>
        <FieldError id={`${id}-color-error`} message={errors.color} />
      </fieldset>

      {withGuest ? (
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={isGuest}
            onChange={(event) => setIsGuest(event.target.checked)}
            className="size-5 accent-[var(--accent-cinema)]"
          />
          Guest (a friend over for the night, not family)
        </label>
      ) : null}

      {children}
      <Button type="submit" size="lg" disabled={pending} className="self-start px-4">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}
