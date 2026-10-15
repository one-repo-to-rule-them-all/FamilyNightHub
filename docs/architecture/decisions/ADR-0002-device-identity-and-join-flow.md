# ADR-0002: Family members are device tokens bound to a person; only admins/hosts have accounts

## Status

Proposed (2026-10-15)

## Context

The core loop must take under two minutes on a Friday night with young kids. Asking kids for
passwords or emails is a non-starter, and several kids have no phone. But the data is private
(photos, history) and votes must not be forgeable. The scope's idea — self-serve usernames
remembered in `localStorage`, and a stable `/join` QR on the fridge — gives the server **no
principal to authorize against**: anyone who once photographed the fridge QR could read albums or
vote as anyone, forever. Safari can also wipe script-writable storage after 7 days of non-use.

## Decision

- **Admins and hosts** sign in by magic link (email via SMTP/Resend). Sign-up is invite-only.
- **Devices**: the fridge QR opens `/j/{household_slug}`, which is a door, not a key. Joining
  requires either a signed-in host/admin on that device, or the **night code** (6 chars, shown on
  the TV, valid only while a session is `voting`/`tonight`, rotates per session). A successful
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
