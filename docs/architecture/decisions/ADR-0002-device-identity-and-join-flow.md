# ADR-0002: Family members are device tokens bound to a person; only admins/hosts have accounts

## Status

Accepted (2026-10-15). Amended 2026-10-18: devices expire after 30 days unused (see
"Amendment: idle timeout" below; issue #56).

## Context

The core loop must take under two minutes on a Friday night with young kids. Asking kids for
passwords or emails is a non-starter, and several kids have no phone. But the data is private
(photos, history) and votes must not be forgeable. The scope's idea — self-serve usernames
remembered in `localStorage`, and a stable `/join` QR on the fridge — gives the server **no
principal to authorize against**: anyone who once photographed the fridge QR could read albums or
vote as anyone, forever. Safari can also wipe script-writable storage after 7 days of non-use.

## Decision

- **Admins and hosts** sign in by magic link (email via SMTP/Resend). Sign-up is invite-only;
  the first admin is created by a CLI bootstrap command (`python -m app.cli bootstrap`).
- **TV**: a host signs in on the TV browser and chooses "Use as TV", which mints a device
  with `is_tv = true` and signs the host session out of that browser.
- **Devices**: the fridge QR opens `/j/{household_slug}`, which is a door, not a key. Joining
  requires either a signed-in host/admin on that device, or the **night code** (6 chars, shown on
  the TV, valid while a session is `draft`/`voting`/`revealed`/`tonight` so people can join
  while the TV shows the lobby, dead once it is `closed`, rotates per session). A successful
  join mints a device token (256-bit random, stored hashed in `devices`) in an **httpOnly, Secure,
  SameSite=Lax cookie** (365-day sliding expiry; 30 days since the 2026-10-18 amendment) — not
  `localStorage`.
- **People** are rows in `people` (name, emoji avatar, colour). After joining, the phone shows an
  avatar grid; picking a person binds a `device_people` row. A device can hold several people
  (shared phone, "pass to next person"). Picking a person already bound to *another* device requires
  host approval on the TV/host screen.
- **Proxy votes**: hosts can cast a ballot for any person; stored with `cast_by_device_id`.
- Admins can revoke a device, rename/merge people, and rotate the household's join slug.

## Alternatives considered

**Usernames in localStorage (scope doc).** Rejected: no server-side principal; impersonation and
permanent access from a photographed QR; Safari storage eviction.

**Per-person PINs.** Rejected for v1: pre-readers can't manage them. Can be added for teens later.

**Full accounts for everyone.** Rejected: too much friction for kids and guests.

## Consequences

- Every write is attributable to a device; votes use `person_id ∈ my bound people`, enforced in SQL.
- Guests get a device token too; admins can revoke it after the night.
- A lost/stolen phone holds a live token until revoked — admin "Devices" list is a v1 requirement.
- **Tests:** device without night code cannot join; revoked device gets 401; device A cannot vote
  as a person bound only to device B (pytest + Playwright).
- See [`03-backend.md`](../03-backend.md) "Auth" and [`05-data.md`](../05-data.md).

## Amendment: idle timeout (2026-10-18, issue #56)

**Owner decision:** a phone or TV not used for **30 days** must enter the night code again. With
a 365-day sliding cookie a known phone never had to, so an occasional visitor's phone kept
household access for a year.

- **Enforced on the server, not only by the cookie.** `current_device` rejects a live token whose
  `COALESCE(last_seen_at, created_at)` is older than `DEVICE_IDLE_DAYS` (default 30) with 401 and
  error code **`device_expired`**. Unknown, revoked and missing tokens keep the generic 401
  (`http_error`), so the distinct code only tells a holder of a real token why. The check runs in
  a short household transaction after the ADR-0009 resolver; the resolver itself is unchanged (no
  new pre-auth column), so no migration.
- **Expired is not revoked.** The row stays (label, history, audit trail) and the admin Phones list
  shows it as "Expired (not used in 30 days)" (`expired: true` on `GET /admin/devices`). Revoked
  wins: a revoked device is never shown as expired.
- **Sliding window.** `last_seen_at` is stamped and the cookie re-issued at most once per
  `DEVICE_TOUCH_INTERVAL_SECONDS` (1 h), so an active device is never more than an hour behind.
  The cookie's `Max-Age` is now `DEVICE_IDLE_DAYS` (30 days) instead of 365.
- **Coming back.** Entering a live night code at `/j/{slug}` (or a host enrollment) revives the
  *same* device row and cookie, stamps `last_seen_at`, and audits `device.rejoined`. The phone UI
  sends an expired phone straight to the join door it last used, with "It's been a while. Enter
  tonight's code."
- **People bindings do not carry over.** Reviving drops the device's `device_people` rows, so
  whoever holds the phone now picks their people again, each with their PIN (ADR-0014). A month
  is long enough for a phone to change hands; keeping the bindings would hand the next holder
  someone else's identity without a PIN.
- **TVs follow the same rule.** Reviving also clears `is_tv`: the night code alone brings a TV
  back as an ordinary phone, and a host has to choose "Use this browser as the TV" again (TV
  rights are host-granted, ADR-0002). The TV's unpaired screen says so.

