# ADR-0015: Admins invite hosts and admins by email; invitees choose their own password

## Status

Accepted (owner request 2026-10-18, issue #71). Amends
[ADR-0014](ADR-0014-passwords-and-person-pins.md) (accounts) and
[ADR-0002](ADR-0002-device-identity-and-join-flow.md) ("sign-up is invite-only", which until
now meant only the `bootstrap` CLI). ADR-0002 and ADR-0014 stay as accepted. The
**platform owner** half of issue #71 is a separate, *Proposed* decision:
[ADR-0016](ADR-0016-platform-owner.md).

## Context

A household has two account roles, `admin` and `host` (`core/permissions.py`). The only way to
create an account was `python -m app.cli bootstrap`, which makes the household's first admin. The
owner wants a second adult, `rbaez0995@gmail.com`, as the Baez Family **host**: run nights,
approve phones, proxy-vote; no PIN resets, people or settings (ADR-0014). `admin:accounts`
("invite hosts") was already in the permission map with nothing behind it.

Constraints from the owner and earlier ADRs:

- Nobody but the invitee ever sets or sees their password: not another admin, not the operator,
  not Claude.
- Household-scoped under FORCE RLS like everything else (ADR-0003).
- Rate limits key on identities, never IP (ADR-0014, `core/rate_limit.py`).
- Every change is audited, and the household must never lose its last admin.

## Decision

- **Invite.** An admin (`admin:accounts`) invites an adult with `{email, display_name, role
  (host|admin), username?}` from the owner portal (**Settings → Hosts & admins**, an admin-only
  group next to Your account, per [owner-portal.md](../proposals/owner-portal.md) §5 P5). The
  account is created with **no password** and the invitee is emailed a single-use link.
- **The link is the ADR-0014 magic link.** Same table, same 256-bit token stored only as a
  peppered hash, same `POST /auth/verify {token, new_password}`, which sets the password and
  signs in in one transaction. Only two things differ: it lives **72 hours**
  (`INVITE_LINK_TTL_HOURS`; a reset link stays 15 minutes) and it carries `&invite=1` so the
  callback page says "Welcome" instead of "New password". The password set from it is audited
  `via: "invite"`.
- **The link is never in an API response.** The admin sees that an invite is pending and when it
  expires, never the token, so an admin cannot sign in as or set a password for anyone else.
- **Resend** mints a new link and expires the old one. It is refused once a password is set (the
  invitee then uses Forgot password like anyone else).
- **Change role** and **remove access** are admin-only. Remove sets `disabled_at` (never a
  delete: nights and audit rows name the account) and expires unused links. `CurrentAccount`
  re-reads the row on every request, so both take effect on the account's next request, with no
  sessions table needed.
- **The last admin.** Both operations lock the household's live admin rows `FOR UPDATE` and
  refuse with 409 if no admin would be left. An admin may step down or remove themself only when
  another admin exists. The lock also serializes two admins removing each other at once.
- **Re-inviting a removed address** revives the same row with the new role and **its password
  cleared**, so an old password never comes back.
- **Uniqueness.** Email and username stay unique across households (ADR-0014: login must be
  unambiguous). An address used by any account is 409. With one household this reveals nothing;
  with several it would let one family's admin learn that an address is in use elsewhere, which is
  one of the reasons ADR-0016 keeps multi-household behind its own decision.
- **Throttling.** Invites and resends are budgeted per inviting account (`INVITE_ACCOUNT_LIMIT`,
  10 per hour) and per invited address (`INVITE_EMAIL_LIMIT`, 3 per hour). Every request counts,
  since each one sends an email. A spent budget is 429 with `Retry-After` before anything is
  written or sent. Fails open like every budget here.
- **Audit.** `account.invited` (role, email, whether it revived a removed account),
  `account.invite_resent`, `account.role_changed` (from, to), `account.removed` (role, email),
  plus the existing `account.password_set` and `account.signed_in`.
- **No migration.** `accounts.disabled_at`, the `role IN ('admin','host')` check,
  `magic_links.expires_at` and both tables' FORCE RLS already cover this.
- **Bootstrap stays** for a household's first admin (there is no one to invite them). Production
  bootstrap repeats the staging steps: bootstrap the owner, then invite the host from the portal
  ([first-deploy.md](../../runbooks/first-deploy.md) steps 11 and 14).

## Alternatives considered

**The admin types a temporary password for the invitee.** Rejected: the admin would know it, the
owner ruled that out, and "change it on first sign-in" is a rule people skip.

**Return the invite link to the admin to forward.** Rejected for the same reason: whoever holds
the link can set the password. The email is the only channel. If email is down, the CLI
`set-password` (operator, with the invitee at the keyboard) is the fallback.

**A separate `invites` table** (pending invite as its own row, account created on acceptance).
Cleaner separation, but it duplicates the magic-link machinery (token hashing, single-use
consumption, a second definer function) for no new guarantee. An account with no password can't
sign in, which is exactly a pending invite.

**Hard-delete on remove.** Rejected: `sessions.host_account_id`, audit rows and PIN-reset
resolutions name the account.

**Per-IP invite throttling.** Rejected as everywhere else in this codebase: a household shares one
NAT address and forwarded headers are spoofable.

## Consequences

- The owner can add the second adult without Claude or the CLI touching credentials.
- An admin can remove another admin. That is deliberate (two parents, equal rights) and audited.
  Only the last admin is protected.
- A removed account's signed-in browsers stop working on their next request; a stolen session for
  a *live* account still can't be revoked on its own (03-backend.md "Account sessions",
  unchanged).
- Invite emails depend on the email provider (first-deploy step 6). An expired or lost invite is
  resent from the portal.
- **Tests:** `tests/integration/test_admin_accounts.py`: invite and accept (the invitee sets the
  password and the response never carries the token), host 403 / TV-window 401 / CSRF, taken
  addresses (same and other household), role changes and the last admin, remove (session dies,
  login fails) and re-invite (password cleared), resend kills the old link, cross-household 404,
  per-address budget 429. Frontend: `lib/accounts.test.ts`, `groups.test.ts`.
- See [`03-backend.md`](../03-backend.md) "Hosts and admins".
