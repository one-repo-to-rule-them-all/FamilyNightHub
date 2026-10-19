/**
 * Hosts & admins (issue #71): the pure parts of the Settings group, so they are unit-tested.
 * The server is the authority on every rule here (last admin, taken emails); these only make the
 * screen say the right thing before a round trip.
 */
import type { AccountRole, AdminAccount } from "@/lib/api";

export const ROLE_LABEL: Record<AccountRole, string> = { admin: "Family admin", host: "Host" };

/** What each role may do (ADR-0014 / core/permissions.py), in the words the invite dialog shows. */
export const ROLE_HELP: Record<AccountRole, string> = {
  host: "Runs movie nights, lets phones in and votes for anyone. No people, PINs or settings.",
  admin: "Everything a host does, plus people, PIN resets, phones, the library and settings.",
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type InviteDraft = { email: string; name: string };

export function inviteProblem(draft: InviteDraft): string | null {
  if (!EMAIL.test(draft.email.trim())) return "Type their email address.";
  if (!draft.name.trim()) return "Type their name, as the family calls them.";
  return null;
}

/** Only one live admin left, and it's this one: the server refuses to demote or remove it. */
export function isLastAdmin(accounts: readonly AdminAccount[], account: AdminAccount): boolean {
  return account.role === "admin" && accounts.filter((a) => a.role === "admin").length === 1;
}

function inWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "within the hour";
  if (hours < 48) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `in ${Math.round(hours / 24)} days`;
}

/** The row's status line: signed up, or the invite's state (pending, or expired → resend). */
export function accountStatus(account: AdminAccount, now: number): string {
  if (account.status === "active") return "Active";
  if (!account.invite_expires_at) return "Invite expired. Resend it.";
  const left = Date.parse(account.invite_expires_at) - now;
  return left > 0 ? `Invited. The link expires ${inWords(left)}.` : "Invite expired. Resend it.";
}
