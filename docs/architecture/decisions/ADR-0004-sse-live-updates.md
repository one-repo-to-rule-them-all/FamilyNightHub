# ADR-0004: Live updates over SSE fanned out through Redis pub/sub, with single-use tickets

## Status

Proposed (2026-10-15). Follows OrderUp ADR-0003 and ADR-0006.

## Context

Phones and the TV must see session status changes (voting opened, ballot count, reveal, tonight)
within about a second. Traffic is tiny (about 10 clients), but phones sleep and drop connections constantly.
Everything flows server→client; the client never needs to push outside normal HTTP. OrderUp has a
working SSE + Redis pub/sub design with ticket auth.

## Decision

- `GET /api/v1/sessions/{id}/stream?ticket=…` streams `text/event-stream`. Tickets come from
  `POST /api/v1/sse-tickets` (device or admin cookie): opaque, 60s TTL, single-use, stored in
  Redis with `household_id` and `session_id`.
- Mutations publish small events to Redis channel `session:{id}`: `status_changed`,
  `ballot_count` (count only), `revealed`, `photo_added`. Events carry **no ballots and no tallies before reveal**.
- Clients treat events as hints and **refetch** the session snapshot (`GET /sessions/{id}`).
  On `visibilitychange`→visible, on reconnect, and every 5s while the stream is down, they refetch too.
- Heartbeat comment every 15s. Fly proxy buffering is disabled for the route.

## Alternatives considered

**WebSockets.** Rejected: no bidirectional need; more lifecycle code.

**Polling only.** Acceptable fallback and kept as one, but the reveal moment on the TV deserves push.

**Postgres LISTEN/NOTIFY.** Rejected: Redis is already required for ARQ and fans out across instances.

## Consequences

- If Redis is down, live push stops and polling keeps phones correct; the UI shows a "reconnecting" chip.
- Because snapshots are authoritative and events are hints, a dropped event can't desync a phone.
- **Tests:** Playwright waits on `data-live="ready"` before acting and asserts on server-derived text
  with `expect.poll`/`toHaveText`, never fixed timeouts; one spec kills the stream mid-vote and
  asserts recovery via polling.
- See [`03-backend.md`](../03-backend.md) "Live updates".
