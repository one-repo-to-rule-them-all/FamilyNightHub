import { describe, expect, it } from "vitest";

import type { PersonTile } from "./api";
import { POLL_MS } from "./live";
import {
  cleanGuestName,
  colorFor,
  currentPerson,
  followWaiting,
  GUEST_EMOJI,
  orderTiles,
  phonePeople,
  resolve,
  tileAction,
  tileBadge,
  waitingPollInterval,
} from "./who";

function tile(overrides: Partial<PersonTile> = {}): PersonTile {
  return {
    id: "p1",
    name: "Ana",
    avatar_emoji: "🦊",
    color: "#3b82f6",
    is_guest: false,
    binding: "free",
    has_pin: true,
    locked: false,
    current: false,
    can_rename: true,
    pin_reset: null,
    ...overrides,
  };
}

describe("resolve", () => {
  const me = tile({ binding: "mine", current: true });

  it("sends a phone with nobody current to Who's watching?", () => {
    expect(resolve([tile()], { id: "n1" })).toEqual({ screen: "who" });
    // A current binding without a PIN (from before ADR-0014) must set one on /who first.
    expect(resolve([tile({ binding: "mine", current: true, has_pin: false })], undefined)).toEqual({
      screen: "who",
    });
  });

  it("lands a current person on the live night, or the no-night screen", () => {
    expect(resolve([tile({ id: "x" }), me], { id: "n1" })).toEqual({
      screen: "night",
      person: me,
      sessionId: "n1",
    });
    expect(resolve([me], undefined)).toEqual({ screen: "no-night", person: me });
  });

  it("ignores a current flag on a binding that isn't this phone's", () => {
    expect(currentPerson([tile({ current: true, binding: "pending" })])).toBeNull();
    expect(currentPerson(undefined)).toBeNull();
  });
});

describe("tiles", () => {
  it("orders family first, then guests, keeping the server's order", () => {
    const people = [
      tile({ id: "g1", is_guest: true }),
      tile({ id: "f1" }),
      tile({ id: "g2", is_guest: true }),
      tile({ id: "f2" }),
    ];
    expect(orderTiles(people).map((p) => p.id)).toEqual(["f1", "f2", "g1", "g2"]);
  });

  it("maps every tile state to its badge and next screen (spec §5 S2)", () => {
    const cases: [Partial<PersonTile>, string | null, string][] = [
      [{ binding: "mine", current: true }, "That's you", "current"],
      [{ binding: "mine" }, null, "enter"],
      [{ binding: "mine", has_pin: false }, "Needs a PIN", "create"],
      [{ binding: "free" }, null, "enter"],
      [{ binding: "free", has_pin: false }, "New", "create"],
      [{ binding: "taken" }, "On another phone", "enter"],
      [{ binding: "taken", has_pin: false }, "On another phone", "ask-host"],
      [{ binding: "pending", has_pin: false }, "Waiting for the host", "pending"],
      [{ locked: true }, "Locked", "locked"],
      [{ locked: true, pin_reset: "open" }, "Locked", "reset-pending"],
      [
        { binding: "taken", has_pin: false, pin_reset: "approved_for_this_phone" },
        "On another phone",
        "create",
      ],
    ];
    for (const [overrides, badge, action] of cases) {
      const person = tile(overrides);
      expect([tileBadge(person), tileAction(person)], JSON.stringify(overrides)).toEqual([
        badge,
        action,
      ]);
    }
  });

  it("puts this phone's current person first on the switch sheet", () => {
    const people = [
      tile({ id: "a", binding: "mine" }),
      tile({ id: "b", binding: "free" }),
      tile({ id: "c", binding: "mine", current: true }),
    ];
    expect(phonePeople(people).map((p) => p.id)).toEqual(["c", "a"]);
  });

  it("polls only while a claim or a PIN reset is waiting", () => {
    expect(waitingPollInterval(undefined)).toBe(false);
    expect(waitingPollInterval([tile()])).toBe(false);
    expect(waitingPollInterval([tile({ binding: "pending" })])).toBe(POLL_MS);
    expect(waitingPollInterval([tile({ pin_reset: "open" })])).toBe(POLL_MS);
  });
});

describe("new guest", () => {
  it("offers eight one-tap pictures and a stable colour per name", () => {
    expect(GUEST_EMOJI).toHaveLength(8);
    expect(colorFor("Abuela")).toBe(colorFor(" abuela "));
    expect(colorFor("Abuela")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("accepts 1–40 characters after trimming", () => {
    expect(cleanGuestName("  Tío   Beto ")).toBe("Tío Beto");
    expect(cleanGuestName("   ")).toBeNull();
    expect(cleanGuestName("x".repeat(41))).toBeNull();
  });
});

describe("followWaiting", () => {
  it("S4: keeps waiting, then follows the host's answer", () => {
    expect(followWaiting("pending", tile({ binding: "pending" }))).toBeNull();
    expect(followWaiting("pending", tile({ binding: "mine", current: true }))).toEqual({
      kind: "done",
    });
    expect(followWaiting("pending", tile({ binding: "mine" }))).toEqual({
      kind: "pin",
      mode: "enter",
    });
    expect(followWaiting("pending", tile({ binding: "mine", has_pin: false }))).toEqual({
      kind: "pin",
      mode: "create",
    });
    expect(followWaiting("pending", tile({ binding: "taken" }))).toEqual({
      kind: "grid",
      notice: "rejected",
    });
    expect(followWaiting("pending", tile({ binding: "taken", locked: true }))).toEqual({
      kind: "locked",
    });
    expect(followWaiting("pending", undefined)).toEqual({ kind: "grid" });
  });

  it("S6: follows the family admin's answer (G2)", () => {
    const locked = { locked: true, has_pin: true };
    expect(followWaiting("reset", tile({ ...locked, pin_reset: "open" }))).toBeNull();
    expect(
      followWaiting("reset", tile({ has_pin: false, pin_reset: "approved_for_this_phone" })),
    ).toEqual({ kind: "pin", mode: "create" });
    expect(followWaiting("reset", tile({ ...locked, pin_reset: null }))).toEqual({
      kind: "locked",
      notice: "dismissed",
    });
    expect(followWaiting("reset", tile({ has_pin: false, pin_reset: null }))).toEqual({
      kind: "pin",
      mode: "create",
    });
    expect(followWaiting("reset", tile({ pin_reset: null }))).toEqual({
      kind: "pin",
      mode: "enter",
      notice: "other-phone",
    });
  });
});
