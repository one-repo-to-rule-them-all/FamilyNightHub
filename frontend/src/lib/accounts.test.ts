import { describe, expect, it } from "vitest";

import { accountStatus, inviteProblem, isLastAdmin } from "@/lib/accounts";
import type { AdminAccount } from "@/lib/api";

const NOW = Date.parse("2026-10-18T12:00:00Z");

function account(over: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id: crypto.randomUUID(),
    email: "a@example.test",
    username: null,
    display_name: "A",
    role: "host",
    status: "active",
    is_you: false,
    invite_expires_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

describe("inviteProblem", () => {
  it("needs an email and a name", () => {
    expect(inviteProblem({ email: "nope", name: "Rafa" })).toMatch(/email/);
    expect(inviteProblem({ email: " r@x.io ", name: "  " })).toMatch(/name/);
    expect(inviteProblem({ email: "r@x.io", name: "Rafa" })).toBeNull();
  });
});

describe("isLastAdmin", () => {
  it("is true only for the one remaining admin", () => {
    const admin = account({ role: "admin" });
    const host = account();
    expect(isLastAdmin([admin, host], admin)).toBe(true);
    expect(isLastAdmin([admin, host], host)).toBe(false);
    const second = account({ role: "admin" });
    expect(isLastAdmin([admin, second, host], admin)).toBe(false);
  });
});

describe("accountStatus", () => {
  it("says when a pending invite expires, and when to resend", () => {
    expect(accountStatus(account(), NOW)).toBe("Active");
    const in3h = new Date(NOW + 3 * 3_600_000).toISOString();
    expect(accountStatus(account({ status: "invited", invite_expires_at: in3h }), NOW)).toBe(
      "Invited. The link expires in 3 hours.",
    );
    const in3d = new Date(NOW + 72 * 3_600_000).toISOString();
    expect(accountStatus(account({ status: "invited", invite_expires_at: in3d }), NOW)).toBe(
      "Invited. The link expires in 3 days.",
    );
    const past = new Date(NOW - 1000).toISOString();
    expect(accountStatus(account({ status: "invited", invite_expires_at: past }), NOW)).toMatch(
      /Resend/,
    );
    expect(accountStatus(account({ status: "invited" }), NOW)).toMatch(/Resend/);
  });
});
