# ADR-0003: Household scoping enforced in app code *and* Postgres RLS via a session GUC

## Status

Accepted (2026-10-15)

## Context

v1 serves one household, but the scope wants other households to "cost nothing later", and the
data includes children's photos. FieldPro scopes tenants only in application code
(`Model.tenant_id == tenant_id` on every query), which one missed filter defeats. OrderUp adds
Postgres RLS keyed on a per-transaction setting. A family app built by one person in evenings is
exactly where a filter gets forgotten.

## Decision

- Every domain table carries `household_id NOT NULL` with an FK and index.
- The request dependency `CurrentHousehold` resolves the household from the device or admin token
  (never from a client parameter) and runs `SET LOCAL app.household_id = '<uuid>'` at the start of
  the transaction.
- Every domain table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy
  `household_id = current_setting('app.household_id')::uuid`. The API connects as a non-owner role
  `fnh_app` (no `BYPASSRLS`). Migrations run as the owner role.
- Queries still filter by household explicitly (defense in depth, better plans).
- Cross-household access returns 404, never 403.
- v1 has **no public household signup**. Multi-household requires a new ADR covering parental
  consent, privacy policy, retention and deletion (COPPA).

## Alternatives considered

**App-only filtering (FieldPro).** Rejected as the sole control: one missed filter leaks photos.

**Schema/database per household.** Rejected: migration fan-out for a hypothetical second tenant.

## Consequences

- `SET LOCAL` requires every request to run inside a transaction, and the worker must set the GUC per
  household when it iterates.
- Connection pooling must be transaction-scoped. `SET LOCAL` is safe with PgBouncer transaction mode;
  plain `SET` is banned (lint rule).
- **CI obligation:** a pytest isolation suite seeds two households and asserts that every
  endpoint and every table returns nothing cross-household. A migration test fails if any table
  with `household_id` lacks `FORCE ROW LEVEL SECURITY` ([`07-cicd.md`](../07-cicd.md)).
- See [`05-data.md`](../05-data.md) "RLS".
