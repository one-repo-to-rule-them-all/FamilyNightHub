import { describe, expect, it } from "vitest";

import { type InboxItem, type NightLike } from "./portal";
import { accountLine, navBadges, pastNights } from "./portal-shell";

const night = (id: string, status: NightLike["status"]): NightLike => ({
  id,
  status,
  title: null,
  created_at: "2026-10-10T19:00:00Z",
});

const claim: InboxItem = {
  kind: "claim",
  id: "claim:d:p",
  at: "2026-10-17T19:00:00Z",
  claim: {
    device_id: "d",
    device_label: "Pixel",
    person_id: "p",
    person_name: "Mia",
    avatar_emoji: "🦊",
    requested_at: "2026-10-17T19:00:00Z",
  },
};
const reset: InboxItem = {
  kind: "pin-reset",
  id: "reset:r",
  at: "2026-10-17T19:00:00Z",
  reset: {
    id: "r",
    person_id: "p",
    person_name: "Mia",
    avatar_emoji: "🦊",
    person_locked: true,
    device_label: null,
    requested_at: "2026-10-17T19:00:00Z",
    status: "open",
  },
};
const locked: InboxItem = {
  kind: "locked",
  id: "locked:q",
  at: "",
  person: { id: "q", name: "Leo", avatar_emoji: "🐢", color: "teal", locked: true },
};
const stale: InboxItem = {
  kind: "stale-night",
  id: "stale:n",
  at: "2026-10-15T19:00:00Z",
  night: night("n", "voting"),
};

describe("navBadges", () => {
  it("shows no badge when nothing needs the owner (AC-P2.6)", () => {
    expect(navBadges([])).toEqual({});
  });

  it("counts every inbox row on Home, neutral without someone waiting (AC-P2.7)", () => {
    expect(navBadges([stale])).toEqual({ home: { count: 1, urgent: false } });
  });

  it("uses the accent on Home for a claim, and leaves People alone", () => {
    expect(navBadges([claim, stale])).toEqual({ home: { count: 2, urgent: true } });
  });

  it("counts PIN requests and locked profiles on People; accent only for a request", () => {
    expect(navBadges([locked]).people).toEqual({ count: 1, urgent: false });
    expect(navBadges([reset, claim, locked])).toEqual({
      home: { count: 3, urgent: true },
      people: { count: 2, urgent: true },
    });
  });
});

describe("pastNights", () => {
  it("keeps nights that have a winner", () => {
    const nights = (["draft", "voting", "revealed", "tonight", "closed"] as const).map((s) =>
      night(s, s),
    );
    expect(pastNights(nights).map((n) => n.id)).toEqual(["revealed", "tonight", "closed"]);
  });
});

describe("accountLine", () => {
  it("names the account and its role", () => {
    expect(accountLine({ display_name: "Rodolfo Baez", role: "admin" })).toBe(
      "Rodolfo Baez · Admin",
    );
    expect(accountLine({ display_name: "Sam", role: "host" })).toBe("Sam · Host");
  });
});
