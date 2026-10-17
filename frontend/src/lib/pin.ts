/**
 * Person PINs on the phone (ADR-0014; guest-flow spec §5 S3). The server is the authority: it
 * hashes, counts wrong tries and locks at 5. This only drives the keypad and turns the API's
 * answers into the spec's copy.
 */
import { ApiError } from "@/lib/api";

export const PIN_LENGTH = 6;

export type PinKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "back" | "clear";

/** The keypad's 3×4 layout: 1–9, then Back, 0, Clear (spec §5 S3). */
export const KEYPAD: readonly PinKey[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "back",
  "0",
  "clear",
];

/** The PIN after one key press: digits stop at six, Back drops one, Clear empties it. */
export function pressKey(pin: string, key: PinKey): string {
  if (key === "back") return pin.slice(0, -1);
  if (key === "clear") return "";
  return pin.length >= PIN_LENGTH ? pin : pin + key;
}

/** Typed digits from a hardware keyboard or paste: digits only, at most six. */
export function cleanPinInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, PIN_LENGTH);
}

export function isCompletePin(pin: string): boolean {
  return pin.length === PIN_LENGTH && /^\d+$/.test(pin);
}

export type PinFailure =
  | { kind: "wrong"; attemptsLeft: number | null }
  | { kind: "locked" }
  | { kind: "slow" }
  | { kind: "other"; error: ApiError };

/**
 * What a refused PIN means. Wrong (403 `wrong_pin`, counted), locked (423 `pin_locked`, until an
 * admin resets it), or the per-phone budget (429). A 403 without `wrong_pin` is something else
 * (the phone doesn't hold them) and is shown as the server's message.
 */
export function pinFailure(error: unknown): PinFailure {
  if (!(error instanceof ApiError)) {
    return { kind: "other", error: new ApiError(0, "unknown_error", String(error)) };
  }
  if (error.status === 423 || error.code === "pin_locked") return { kind: "locked" };
  if (error.code === "wrong_pin") return { kind: "wrong", attemptsLeft: error.attemptsLeft };
  if (error.status === 429) return { kind: "slow" };
  return { kind: "other", error };
}

/** `copy.s3.wrong` / `copy.s3.wrongLast`. */
export function wrongPinCopy(attemptsLeft: number | null, name: string): string {
  if (attemptsLeft === null) return "Not quite. Try again.";
  if (attemptsLeft === 1) return `Not quite. 1 try left before ${name} gets locked.`;
  return `Not quite. ${attemptsLeft} tries left.`;
}

export const PIN_SLOW_COPY = "Too many wrong PINs on this phone. Wait a few minutes and try again.";
export const PIN_MISMATCH_COPY = "Those didn't match. Let's try again.";
