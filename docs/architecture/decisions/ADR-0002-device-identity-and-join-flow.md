# ADR-0002: Family members are device tokens bound to a person; only admins/hosts have accounts

## Status

Accepted (2026-10-15). Amended 2026-10-18: "Open TV window" (see the end of this ADR).

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
  SameSite=Lax cookie** (365-day sliding expiry) — not `localStorage`.
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

## Amendment 2026-10-18: the host's laptop opens the TV in a second window (issue #57)

**Context.** The owner runs nights from a laptop plugged into the living-room TV. "Use as TV"
turned the portal tab itself into the TV and signed the host out, so running the night meant
signing in again somewhere else. A second tab can't fix that alone: tabs share the cookie jar,
and the TV enrollment cleared `fnh_session` for the whole browser.

**Decision.** On the host's own machine the browser holds **both** credentials, and each window
says which one it means.
- `POST /devices/enroll {as_tv: true, keep_session: true}` marks this browser's device as the TV
  and **keeps** `fnh_session`. Without `keep_session` nothing changes: Settings → "Use this
  browser as the TV" still signs the host out, for a browser that is *only* the TV (a smart-TV
  browser).
- The cookies already coexist: `fnh_device` and `fnh_session` have different names, both on
  `Path=/`, and the device cookie's sliding re-issue only ever writes `fnh_device`.
- Every request from `/tv` and `/tv/*` sends `X-FNH-Device-Only: 1` (`lib/api.ts`). With it the
  API ignores `fnh_session`: `current_account` is 401 and `current_viewer` resolves the device
  only, or 401 if there is none. The TV window therefore sees exactly what a dedicated TV sees
  (hidden photos stay hidden), can't call an account route even by mistake, and shows "not
  paired" rather than host data if its device is revoked. The header can only remove authority,
  so it needs no protection of its own.
- "Open TV window" on Home's Up-next card and the night page opens a named window
  (`fnh-tv`, reused on a second tap) synchronously in the click, enrolls, then navigates it to
  `/tv/{night}` and copies the night code from this tab's `sessionStorage` into it. If a popup
  blocker eats the window, the portal shows a plain link instead. The TV screens never link into
  the portal; the only exit is the unpaired screen's "Host sign-in".

**Trade-off.** Anyone at that laptop can open the portal in another tab: the TV window has no
host rights, but the browser does. That is acceptable because it is the host's own machine,
which is already signed in. A browser left in the living room as a dedicated screen should still
use the sign-out path above (or a pairing code, below). The host's phones are separate browsers
and unaffected. As before, enrolling reuses a device the browser already holds, so a laptop that
was also used as a phone becomes the TV with its people still bound.

**Not done here: "Pair a TV" short code** (Option B in #57), for a separate screen (smart-TV
browser, Fire TV) without anyone signing in on it: the TV shows a short code, the host types it
in the portal, which mints a TV device for that screen. It needs a new pre-auth pairing table or
Redis key with a TTL, a rate limit, a pairing poll on `/tv`, and a portal form. Filed as #61, its own
issue, since it is more than half a day of work.
