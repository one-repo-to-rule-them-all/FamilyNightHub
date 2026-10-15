# ADR-0009: Pre-authentication lookups go through narrow SECURITY DEFINER functions owned by a resolver role

## Status

Accepted (2026-10-15). Extends [ADR-0003](ADR-0003-household-scoping-app-plus-rls.md).

## Context

ADR-0003 forces RLS on every household-scoped table and makes the household come from the
credential. But a few lookups have to run *before* the household is known, because they
are how the household becomes known:

- `CurrentDevice`: find the device row by `token_hash` from the `fnh_device` cookie.
- Magic-link verify: find the link by `token_hash`. Magic-link request: find the account by email.
- Join: find the household by `join_slug` (`/j/{slug}`).
- Worker: list the households to iterate (06).

With FORCE RLS and no `app.household_id` set, the policy evaluates to NULL and every one
of these returns nothing, so nobody can authenticate. Setting the GUC from a request value
would violate ADR-0003, and giving `fnh_app` an exception policy would widen the
runtime role's view of every row.

## Decision

- A `NOLOGIN` role **`fnh_resolver`** owns five `SECURITY DEFINER` SQL functions:
  `auth_resolve_device(token_hash)`, `auth_resolve_magic_link(token_hash)`,
  `auth_resolve_account_by_email(email)`, `auth_resolve_household_by_slug(slug)` and
  `worker_list_household_ids()`. Each returns **only ids** (`id`, `household_id`), never a
  full row, and only for live credentials (not revoked, not expired, not used).
- `fnh_resolver` has **column-level** `SELECT` on just the columns those functions read, and
  a `FOR SELECT TO fnh_resolver USING (true)` policy on just those four tables. It has no
  `BYPASSRLS`, no `LOGIN`, and no write privilege. Nothing else is granted to it.
- Every function pins `search_path = pg_catalog, public`, is `STABLE`, has `EXECUTE`
  revoked from `PUBLIC` and granted to `fnh_app` only.
- After resolution the caller opens the normal household transaction (GUC set) and does
  all further reads and writes as `fnh_app` under RLS. Consuming a magic link, touching
  `devices.last_seen_at`, etc. happen there, not in the functions.
- The role is created at provisioning (`backend/db/init/00-init-app-role.sql`, needs
  `CREATEROLE`) and granted to the owner so migrations can set function ownership. The
  migration fails loudly if the role is missing.

## Alternatives considered

**Owner-owned definer functions.** Rejected: FORCE RLS binds the owner too, so they only
work if the owner is a superuser. That holds in Compose, not reliably on managed Postgres,
and a superuser-owned definer function is the most dangerous kind.

**A `BYPASSRLS` resolver role.** Rejected: needs superuser to create, and sees every
column of every table instead of four columns of four tables.

**Unscoped token lookup tables (`device_tokens` without RLS).** Rejected: a second copy of
credential data that `fnh_app` could enumerate.

## Consequences

- RLS stays forced everywhere, with no global exception for the runtime role.
- Five functions are the whole pre-auth surface. Adding one is a new migration and a review
  of this ADR; tests pin the exact set.
- `auth_resolve_account_by_email` reveals whether an email has an account to whoever can
  call it. Only `fnh_app` can, and the magic-link endpoint answers identically either way.
- **Tests:** the resolver set and owner are pinned; each function returns ids only and
  ignores revoked/expired/used credentials; `fnh_app` still sees nothing without the GUC;
  `fnh_resolver` cannot log in or write.
- See [`03-backend.md`](../03-backend.md) "Auth" and [`05-data.md`](../05-data.md) "RLS".
