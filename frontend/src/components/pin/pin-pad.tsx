"use client";

import { Delete, Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cleanPinInput, isCompletePin, KEYPAD, PIN_LENGTH, type PinKey, pressKey } from "@/lib/pin";
import { cn } from "@/lib/utils";

/**
 * Six dots and a big 0–9 keypad that submits on the 6th digit (guest-flow spec §5 S3): the
 * keypad is the primary action, so there is no OK button. Keys are ≥ 64px. A hidden input takes
 * a hardware keyboard or a paste; it keeps `autocomplete="off"` so no password manager offers to
 * save a kid's PIN. Holding the eye shows the digits while held.
 *
 * `attempt` changes after every refused PIN: the dots shake and clear for the next try.
 */
export function PinPad({
  onComplete,
  busy = false,
  disabled = false,
  attempt = 0,
  label,
}: {
  onComplete: (pin: string) => void;
  busy?: boolean;
  disabled?: boolean;
  attempt?: number;
  label: string;
}) {
  const [pin, setPin] = useState("");
  const [peek, setPeek] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [seenAttempt, setSeenAttempt] = useState(attempt);
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = busy || disabled;

  // A refused PIN: clear the dots and shake (adjusting state during render, not in an effect).
  if (attempt !== seenAttempt) {
    setSeenAttempt(attempt);
    setPin("");
    setShaking(attempt > 0);
  }

  useEffect(() => {
    if (!shaking) return;
    const timer = setTimeout(() => setShaking(false), 400);
    return () => clearTimeout(timer);
  }, [shaking]);

  const update = (next: string) => {
    if (locked) return;
    setPin(next);
    if (isCompletePin(next)) onComplete(next);
  };

  return (
    <div className="flex flex-col items-center gap-5" data-testid="pin-pad">
      <div className="flex items-center gap-3">
        <div
          role="img"
          aria-label={`${label}: ${pin.length} of ${PIN_LENGTH} digits`}
          className={cn("flex gap-3", shaking && "animate-[pin-shake_0.4s_ease-in-out]")}
          data-testid="pin-dots"
          data-filled={pin.length}
        >
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span
              key={i}
              aria-hidden
              className={cn(
                "flex size-5 items-center justify-center rounded-full ring-2 ring-foreground/40",
                i < pin.length && !peek && "bg-foreground ring-foreground",
                peek && "size-7 font-mono text-lg ring-0",
              )}
            >
              {peek ? (pin[i] ?? "·") : null}
            </span>
          ))}
        </div>
        <button
          type="button"
          aria-label="Hold to show the digits"
          onPointerDown={() => setPeek(true)}
          onPointerUp={() => setPeek(false)}
          onPointerLeave={() => setPeek(false)}
          onPointerCancel={() => setPeek(false)}
          className="flex size-11 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <Eye aria-hidden className="size-5" />
        </button>
      </div>

      <input
        ref={inputRef}
        aria-label={label}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        disabled={locked}
        maxLength={PIN_LENGTH}
        onChange={(event) => update(cleanPinInput(event.target.value))}
        className="sr-only"
        data-testid="pin-input"
      />

      <div
        role="group"
        aria-label="Keypad"
        className="grid w-full max-w-xs grid-cols-3 gap-3"
        aria-busy={busy || undefined}
      >
        {KEYPAD.map((key) => (
          <Key key={key} value={key} disabled={locked} onPress={(k) => update(pressKey(pin, k))} />
        ))}
      </div>
    </div>
  );
}

function Key({
  value,
  disabled,
  onPress,
}: {
  value: PinKey;
  disabled: boolean;
  onPress: (key: PinKey) => void;
}) {
  const digit = value !== "back" && value !== "clear";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPress(value)}
      aria-label={value === "back" ? "Back" : value === "clear" ? "Clear" : value}
      data-key={value}
      className={cn(
        "flex h-16 min-h-16 items-center justify-center rounded-2xl text-2xl font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring active:scale-[0.97] disabled:opacity-50",
        digit ? "bg-secondary text-secondary-foreground" : "text-base text-muted-foreground",
      )}
    >
      {value === "back" ? (
        <Delete aria-hidden className="size-6" />
      ) : value === "clear" ? (
        "Clear"
      ) : (
        value
      )}
    </button>
  );
}
