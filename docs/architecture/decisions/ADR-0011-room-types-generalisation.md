# ADR-0011: Generalise nights to room types with one options table and a pinned catalog reference

## Status

Proposed (2026-10-15). Draft for the owner's decision; not accepted. Analysis in
[`proposals/room-types.md`](../proposals/room-types.md).

## Context

Phase 3+ defers "other room types" (dinner vote, game-night pick, outing, potluck…). Almost all of
the night is already room-agnostic: the lifecycle in `domain/session_state.py`, join and devices
(ADR-0002), the tally interface in `domain/voting/` (which takes option ids only, ADR-0006), SSE
(ADR-0004), photos (ADR-0005) and ratings all key on `session_id` and `option_id`.

The structural blocker is `options.movie_id NOT NULL` with its composite FK to `movies`. Everything
that makes the vote trustworthy hangs off `options`: ballots reference `(option_id, session_id)`,
and the winner references `(winner_option_id, id)`, so a ballot or a winner can never point
outside its own night. Any generalisation must keep both guarantees, keep household isolation
(ADR-0003) at the database level, and migrate live Phase-1 data without a contract step.

## Decision

- **`sessions.room_type`** (`movie` default, CHECK-listed values), immutable once set. Exposed as
  `unique(id, room_type)` so children can pin to it. `age_cap` must be NULL unless the room is
  `movie`.
- **One `options` table for every room.** Each option references exactly one catalog row:
  `movie_id` (→ `movies`) for movie rooms, `item_id` (→ a new household-scoped **`items`**
  catalog: `kind`, `name`, `emoji`, `url`, `min_players`, `max_players`, `blocked`) for every
  other room. `options.movie_id` becomes nullable; CHECKs require the reference that matches the
  room and forbid the other.
- **Pin the option's kind to its night in the database:** `options.room_type` with FK
  `(session_id, room_type) → sessions(id, room_type)`. A dinner night cannot hold a movie, and a
  night's type cannot change under its options.
- Typed options auto-create a catalog row, as typed movie titles already create `movies` rows.
- **`ballot_ranks`, the winner FK, `photos`, `ratings` and `domain/voting/` do not change.**
- Per-room behaviour (transitions, option bounds, whether it is tallied, copy) lives in a pure
  `RoomPolicy` in `backend/app/domain/`; `MoviePolicy` equals today's constants (golden test).
- `items` ships with `ENABLE` + `FORCE` RLS and the `household_isolation` policy in the same
  migration, and joins the RLS coverage pin and the isolation suite.
- The API changes additively (`room_type`, `item_id`, `emoji`, `url`; `title` is the universal
  display name). Frontend URLs stay type-agnostic (`/s/[session]`, `/tv/[session]`,
  `/host/[session]`) and branch on `room_type` through a per-kind component registry.
- The first room built on this is the dinner/takeout vote.

## Alternatives considered

**Per-type option tables sharing the session/ballot machinery.** Rejected: `ballot_ranks.option_id`
and `sessions.winner_option_id` can reference one table each, so this forces per-type ballot
tables (duplicating the integrity machinery) or a supertype `options` table, which is this
decision with extra joins. Every new room would also add a household table to secure.

**Keep `options` movie-only and add a parallel option table.** Rejected: ballots and the winner
need a second nullable reference each with exactly-one CHECKs, the "winner is one of this night's
options" guarantee stops being a single FK, and every read becomes a UNION. Cheapest migration,
most expensive everything else.

**Free-text label columns on `options` instead of an `items` catalog.** Rejected: dinner places and
games repeat weekly; without a stable identity there is no history per place, no blocking, no
average rating and no "not the same as last time".

**JSONB details on `options` or `items`.** Rejected for now: the per-kind fields are few and known,
and typed columns keep CHECKs and the OpenAPI contract honest.

**Type-specific URLs (`/s/dinner/[id]`).** Rejected: the QR/night-code join resolves a session id,
not a type, and existing history and album links would break.

## Consequences

- **Migration is expand-only.** `ADD COLUMN … DEFAULT 'movie'` is metadata-only, so every existing
  night becomes a movie night in place; `DROP NOT NULL` is a catalog change; new FKs/CHECKs go in
  `NOT VALID` then `VALIDATE`. Nothing is renamed or removed, so there is no contract step. Old
  machines mid-rollout see only movie rows. Rollback is code-only; `downgrade()` must refuse while
  any non-movie night exists.
- **Integrity gains a guarantee** (option kind pinned to session kind) and loses none.
- **Tests:** tally property tests are unchanged. New obligations: a migration test proving Phase-1
  responses are unchanged after upgrade; constraint tests for each wrong-reference case; `items`
  in the RLS coverage pin and isolation suite; a multi-phone E2E per room slice.
- **The generator stays movie-only** (ADR-0007 unchanged). Any "pick for me" over items is a
  separate, smaller rule set.
- **Potluck** later adds a `claims` table (FK `(option_id, session_id)`, unique per single-capacity
  slot) and a non-tallied `RoomPolicy`; no change to this decision.
- **Out of scope, unchanged:** multi-household still needs a consent/COPPA ADR (ADR-0003); public
  sharing still needs its own ADR (ADR-0005); game scores stay in Ctrl+Alt+Defeat, linked, never
  synced.
