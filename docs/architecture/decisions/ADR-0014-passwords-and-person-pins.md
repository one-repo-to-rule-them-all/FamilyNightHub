# ADR-0014: Passwords for accounts, a required 6-digit PIN for every person

## Status

Accepted (owner decision 2026-10-17). Supersedes the parts of
[ADR-0002](ADR-0002-device-identity-and-join-flow.md) that make the magic link the only way an
account signs in, that reject per-person PINs for v1, and that make host approval the only way
to claim a person bound to another phone. Adds one resolver function to
[ADR-0009](ADR-0009-pre-auth-lookups-via-definer-functions.md). Relaxes one line of
[ADR-0006](ADR-0006-voting-rules-and-tie-break.md) for revealed nights (see "Profiles").
ADR-0002, ADR-0006 and ADR-0009 stay as accepted.

## Context

ADR-0002 gave admins and hosts magic-link-only accounts and gave everyone else no credential
but the phone. Two things changed:

- The owner wants **username (or email) + password** sign-in, like their other apps. A magic
  link every time is slow on a TV remote and depends on the email provider being up on a Friday
  night.
- The phone alone is a weak proof of *who* is holding it. A shared tablet can act as every kid
  bound to it, a guest can tap any free tile, and claiming someone already on another phone
  needs a host to approve it on the TV. The owner wants a **required 6-digit PIN per person**,
  admin-approved PIN resets, self-created guest profiles, a one-time rename and a per-person
  history page.

ADR-0002 rejected PINs because pre-readers can't manage them. The answer here is that they
don't have to: **a parent enters a kid's PIN**, the same way a parent already hands the phone
over. Once a phone is set to a person it stays set, so the PIN is typed when claiming or
switching, not on every vote.

## Decision

### Accounts: password sign-in, magic link only for "forgot password"

- `accounts` gains `username` (nullable, 3–32 chars of `[a-z0-9._-]`, stored lowercase, unique
  case-insensitively across households, never contains `@`), `password_hash` (nullable until
  set) and `password_changed_at`.
- `POST /auth/login {username_or_email, password}` sets the existing signed `fnh_session`
  cookie (unchanged format and lifetime). An identifier containing `@` is looked up by email,
  anything else by username. CSRF double-submit like every mutation.
- **No enumeration.** Unknown identifier, disabled account, account with no password yet and
  wrong password all get the same 401 and the same message, and all of them run one argon2
  verification (against a fixed dummy hash when there is no real one), so timing does not
  separate them either.
- **Throttling** uses `core/rate_limit.py` budgets keyed on request identities, never IP:
  failures per normalized identifier (`LOGIN_FAILURE_LIMIT`, default 10 per 15 min) and
  failures per account (`LOGIN_ACCOUNT_FAILURE_LIMIT`, default 20 per 15 min, so trying the
  email and the username of one account shares a budget). A spent budget answers 429 with
  `Retry-After` before any password is checked, so a correct guess cannot slip through. The
  identifier budget applies to unknown identifiers exactly as to known ones. Like the join
  limiter, it fails open if Redis is down; argon2's cost is the backstop.
- `POST /auth/password {current_password?, new_password}` sets or changes the password of
  the signed-in account. Changing an existing password requires the current one (a wrong one
  spends the account's failure budget).
- **Forgot password.** `POST /auth/magic-link` is unchanged (same 202 for every address).
  `POST /auth/verify {token, new_password}` now **requires** a new password: consuming the
  link sets it and signs the account in, in one transaction. The link is therefore a password
  reset, not a second way to sign in. The password is validated before the link is consumed,
  so a rejected password does not burn the link.
- **Password rules:** 12–256 characters, not all one character, not the username or email,
  not on a short denylist of common long passwords. No composition rules (NIST SP 800-63B).
- **CLI:** `python -m app.cli set-password --email ... [--username ...]` reads the password
  from stdin when piped, else from a hidden prompt (twice). Never from argv, which leaks into
  shell history and `ps`. `bootstrap` takes an optional `--username`.

### Hashing

- **argon2id** via `argon2-cffi` for passwords and PINs, with `m = 19 MiB, t = 2, p = 1`
  (the OWASP minimum). The API machine has 512 MB; at the library default of 64 MiB, ten
  phones claiming at once would need 640 MB. Hashing runs in a worker thread so it doesn't
  block the event loop. Hashes are upgraded on the next successful check if the parameters
  change.
- **PINs are low entropy** (10^6 values). argon2 slows an offline guess, but against a
  stolen database a million guesses is hours, not years. Two things make PINs safe instead:
  1. **The attempt limit** (below) is the real defense online.
  2. **The PIN is peppered before hashing:** argon2id over
     `HMAC(DEVICE_TOKEN_PEPPER, "pin:{person_id}:{pin}")`. The pepper lives only in fly
     secrets (as for device tokens), so a database dump alone cannot verify a single guess,
     and the person id stops a hash being copied to another person. Rotating the pepper
     already invalidates every device token; it now invalidates every PIN too (everyone sets
     a new one on next claim).

### People: required PIN, lockout, resets

- `people` gains `pin_hash`, `pin_set_at`, `pin_failed_attempts`, `pin_locked_at` and
  `name_changed_at`. `device_people` gains `is_current` (at most one per device, partial
  unique index): **the person this phone is currently acting as.**
- **The phone stays the everyday credential.** Ballots, ratings, photos and reactions check
  `require_can_act_as`: an *active* binding, that is *current* on this device, for a person
  who *has a PIN*. The PIN is not sent with each vote.
- **How the current person is tracked:** `device_people.is_current`, set only by a
  successful claim or switch with the PIN (or a host approving a pending claim, or setting a
  PIN on this phone). Setting it clears the device's previous current person in the same
  transaction. Ballots, ratings, photos and reactions act as that person only; host proxy
  voting and rating are unaffected (they never go through a device binding).
- **Claiming or switching needs the PIN, on every switch** (`PUT /devices/me/people/{id}
  {pin}`). Being actively bound to this same phone is not enough to act as someone who isn't
  current: switching back and forth on a shared phone takes the PIN each time.
  - Already current on this phone: no-op, no PIN.
  - The person has a PIN: the right PIN makes the binding active and current, even if
    another phone holds them too. **This replaces host approval** for people with a PIN.
  - The person has no PIN and nobody else holds them, or this phone already holds them, or
    an admin approved a PIN reset that *this phone* asked for: this is the first claim, and
    the request **must** set the PIN.
  - The person has no PIN but another live phone holds them: this phone cannot set their
    PIN (that would be a takeover). The claim goes `pending` for host approval, as before.
  - No PIN sent for a person who has one, from a phone that doesn't hold them yet: the claim
    goes `pending` for host approval (the **admin override**). A switch on a phone that
    already holds them, or a first claim, without a PIN is 422.
  - A locked person refuses every claim, pending included (423).
- **Existing people** (before this migration) have no PIN. Their bound phones keep the
  binding but cannot act as them until a PIN is set on that phone
  (`POST /devices/me/people/{id}/pin`), which also makes the person current.
- **Lockout.** Each wrong PIN, on any route that checks one, increments
  `pin_failed_attempts` in the request's transaction; the router answers with a response
  rather than an exception so the count commits. At **5** the profile is locked
  (`pin_locked_at`) and every PIN check answers **423** with a clear message, even for the
  right PIN, until an admin resets it. The right PIN resets the count to 0. The person row is
  locked `FOR UPDATE` while a PIN is checked, so parallel guesses cannot race past the limit.
  A lock blocks claiming, switching and PIN changes; it does not unbind phones that already
  act as the person. Otherwise anyone with the night code could lock a family member out of
  their own phone by typing five wrong PINs.
- **Per-device budget.** Wrong PINs are also budgeted per device in Redis
  (`PIN_FAILURE_LIMIT`, default 10 per 15 min), so one phone cannot lock every profile in
  the household in one sitting.
- **Forgot PIN.** `POST /devices/me/people/{id}/forgot-pin` records a `pin_reset_requests`
  row (household-scoped, FORCE RLS, `status open/approved/dismissed`, one open request per
  person, idempotent while open, allowed on a locked person). **Only admins**
  (`admin:people`) list open requests, **approve**
  (clears the hash, `pin_set_at`, the count and the lock, audits `person.pin_reset`) or
  **dismiss**. Approval never reveals or sets a PIN: the person sets a new one on their next
  claim, and the requesting phone may do so even if another phone still holds the person.
  Hosts can neither list nor approve resets (owner decision). Tiles carry
  `pin_reset: null | "open" | "approved_for_this_phone"`, so a phone shows the right step after
  a reload.
- **Self-create.** `POST /devices/me/people {name, avatar_emoji, color, pin}`: any household
  device (it got in with the night code) may add a profile. It is always `is_guest = true`,
  bound active and current to this phone, with its PIN set in the same request. Admins
  convert or merge it with the existing endpoints. Budgeted per device
  (`SELF_CREATE_LIMIT`, default 5 per hour). Names follow the admin rules (unique per
  household, case-insensitively).
- **Rename once.** The person current on this phone may change their own display name once
  (`PATCH /devices/me/people/{id}`, sets `name_changed_at`); after that it is 409. Admin
  rename is unchanged and does not count.
- **Kids.** Every person needs a PIN, so a kid's is set and typed by a parent. The kid's
  phone is then set to the kid and never asks again unless someone switches.

### The TV's join QR

`settings.qr_includes_night_code` (bool, default false; `PATCH /admin/settings`,
`admin:settings`) lets the TV's QR carry the night code (`/j/{slug}?code={code}`), so a phone
can join without typing it. The plaintext code is still **never stored or returned** by the
server (ADR-0002 keeps only its hash): `GET /devices/me/join-link` gives the TV (an `is_tv`
device) or a host account (`sessions:run`) `{join_slug, qr_includes_night_code}`, and the TV
appends the code it already holds from create/rotate. Other phones get 403. With the setting
on, the code is in a URL that reaches the web server, so request logs for `/j/*` should drop the
query string and the page should send `Referrer-Policy: no-referrer` (frontend follow-up).

### Profiles

`GET /people/{id}/profile` (any device or account of the household; another household's
person or a merged one is 404) returns nights joined, the person's ballots, the winners they
ranked first, their ratings, the count of photos they uploaded with links to the albums, and
simple stats. **Ballots appear only for nights that are `revealed`, `tonight` or `closed`.**
ADR-0006 says ballots are never readable by other devices; that stays true until the reveal,
which is what protects the vote. After the reveal, the owner decided a person's past picks
and ratings are family history, visible to the household like the album.

### Pre-auth surface

`auth_resolve_account_by_username(text)` is the sixth ADR-0009 function: same shape as
`auth_resolve_account_by_email` (ids only, live accounts only, owner `fnh_resolver`,
`search_path` pinned, `EXECUTE` for `fnh_app` only), with a column grant on
`accounts.username` added to the resolver's existing four. The password hash is **not**
readable by the resolver: it is read and verified as `fnh_app` under RLS once the household is
known. `tests/integration/test_rls_coverage.py` pins the new set.

## Amendment 2026-10-28: admins reset a PIN directly (issue #88)

**Context.** A reset could only start from the person's phone ("Ask the family admin"). The
owner found a locked person on People and in Home → Needs you with nothing to press.

**Decision.** `POST /admin/people/{id}/reset-pin` (`admin:people`, CSRF; hosts 403) does the
same clear as approving a request: the hash, `pin_set_at`, the count and the lock. It works
whether or not the person is locked, so an admin can also reset a forgotten PIN. Any open
request for that person is closed as **approved** (so the phone that asked may still set the
new PIN), and `person.pin_reset` is audited with `{direct: true}` (plus the closed request
ids). The admin still never sees or sets a PIN: the person chooses one on their phone, under
the usual first-claim rules (a phone that already holds them, or nobody else does).

## Alternatives considered

**Keep magic-link-only accounts.** Rejected by the owner: slow, and an email outage locks the
admin out on movie night.

**PIN on every action instead of per claim.** Rejected: a five-year-old voting would need a
parent for each tap, and it multiplies the guessing surface by every ballot.

**4-digit PINs.** Rejected: with a 5-attempt limit both are safe online, but 6 digits cost a
parent nothing extra and make an offline guess 100x harder if the pepper ever leaks.

**Lock forever vs time-based unlock.** A timed unlock lets a patient guesser take 5 tries an
hour indefinitely. The owner chose an admin reset. The per-device budget limits how fast a
single phone can lock people out.

**Bcrypt or scrypt.** argon2id is the current OWASP/RFC 9106 recommendation and is
memory-hard. `argon2-cffi` is maintained and has wheels for the slim image.

**A sessions table for account sign-in.** Not needed for this change. The stateless cookie
and its revocation trade-off (03-backend.md "Account sessions") are unchanged; changing a
password does not sign out other browsers. Revisit with the sessions-table note there.

## Consequences

- An account signs in by password. The magic link still exists, but only to set a new one.
  Existing accounts set their first password through the link or the CLI.
- Every person has a PIN before a phone can act as them; existing bindings prompt for one on
  next use. The frontend must send `pin` on claims, offer set-PIN and forgot-PIN, show the
  423 lock, and switch the current person before voting on a shared phone.
- Host approval of pending claims remains, as the override for people without a PIN and for
  claims sent without one.
- One more definer function: the pre-auth surface is six functions, still ids only.
- Profiles expose a person's revealed ballots and ratings to their household, a deliberate
  change from ADR-0006's "never readable by other devices" after the reveal.
- **Tests:** password login success/failure, throttling, no enumeration, forgot-password; PIN
  set, claim, wrong PIN counting, lock at 5, a locked profile refusing the right PIN; reset
  request, approval clearing the lock without exposing a PIN; rename once; self-create;
  cross-household 404 on every new route; the profile hiding ballots before reveal.
- See [`03-backend.md`](../03-backend.md) "Auth" and [`05-data.md`](../05-data.md).
