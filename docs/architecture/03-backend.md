# 03 — Backend

FastAPI + Python 3.12 + Pydantic v2 + SQLAlchemy 2 (async, asyncpg) + Alembic, with ARQ workers on
Redis. It mirrors the OrderUp/FieldPro backend layout, so the FieldPro "pitfalls" list applies here too.

## App structure

`backend/app/main.py` builds the app with middleware in this order: request ID → CORS-aware error
envelope (FieldPro `cors.py` pattern) → routers under `/api/v1`. Rate limiting is not middleware: it
is a failure budget the join (and later magic-link) handlers consult (`core/rate_limit.py`).

```
backend/app/
  api/v1/      join.py, auth.py, people.py, devices.py, sessions.py, ballots.py,
               photos.py, ratings.py, movies.py, admin/*.py, stream.py, health.py
  core/        config.py, database.py, dependencies.py, security.py, rate_limit.py
  domain/      voting/ (top3.py, approval.py, pick_one.py, base.py), session_state.py, generator.py
  integrations/ tmdb.py, storage.py, email.py
  models/  schemas/  services/  workers/
```

## Route / service map

| Area | Path prefix | Notes |
|---|---|---|
| Join | `GET /api/v1/csrf`, `POST /api/v1/join` | Issue the CSRF cookie; validate slug + night code, mint the device cookie (failure-budgeted) |
| Auth | `/api/v1/auth/{magic-link,verify,me,logout}` | Magic-link request/verify for admins and hosts, current account, logout |
| People/devices | `/api/v1/people`, `/api/v1/devices/me`, `PUT/DELETE /api/v1/devices/me/people/{id}` | Avatar grid with each tile's binding state, bind or unbind a person to this device |
| Host devices | `POST /api/v1/devices/enroll`, `GET /api/v1/devices/claims`, `POST /api/v1/devices/{id}/people/{pid}/{approve,reject}` | Host lets a browser in without the code (`as_tv` pairs the TV and clears the host session from it); review pending person claims (`devices:enroll` / `devices:approve`) |
| Sessions | `POST /api/v1/sessions`, `GET /sessions[?status=&limit=]`, `GET /sessions/{id}`, `POST /sessions/{id}/night-code`, `POST/DELETE /sessions/{id}/options[/{oid}]`, `PUT /sessions/{id}/options/order`, `POST /sessions/{id}/{open-voting,close-voting,close}` | Host (`sessions:run`): create (code shown once), rotate code, shortlist, open/close voting, close the night. Snapshot and history: any device or account of the household |
| Ballots | `PUT /api/v1/sessions/{id}/ballots`, `PUT …/ballots/proxy`, `GET …/ballots/mine`, `GET …/voters` | Phone casts/replaces a bound person's ballot; host proxy ballot (`ballots:proxy`); a phone reads back its own people's ballots; who has voted (avatars only) |
| Live | `/api/v1/sse-tickets`, `/api/v1/sessions/{id}/stream` | [ADR-0004](decisions/ADR-0004-sse-live-updates.md) |
| Photos | `/api/v1/sessions/{id}/photos` | Presign, complete, list (presigned GETs), react, hide/delete |
| Ratings | `/api/v1/sessions/{id}/ratings` | 1–5 per person, once the night is `tonight`/`closed` |
| Movies | `/api/v1/movies`, `GET /api/v1/tmdb/search?q=` | Library, owned flag (later); TMDB search proxy for hosts (503 when TMDB is off or down) |
| Admin | `/api/v1/admin/*` | People merge/rename, device revoke, history edit, settings |
| Health | `/api/health` | DB + Redis |

## Request lifecycle

A ballot submit goes through these steps:

1. Pydantic validates `{person_id, ranks: [{option_id, rank}]}`.
2. `CurrentDevice` hashes the cookie token and resolves it with `auth_resolve_device()`
   ([ADR-0009](decisions/ADR-0009-pre-auth-lookups-via-definer-functions.md)); unknown or revoked → 401.
3. `DeviceDb` (`core/dependencies.py`) opens the request's one transaction and sets the household
   GUC with `set_config(..., true)`; it also slides the cookie and `last_seen_at` at most hourly.
4. `BallotService` checks the session is `voting`, that the person is bound to the device
   (`people_service.require_can_act_as`: an **active** binding; pending claims don't count) or the caller is a host, and that the ranks are valid for `k`. It then replaces the ballot rows.
5. It queues a `ballot_count` hint for `session:{id}` (count changed, nothing else).
6. Commit, then the hint is published (see "Live updates"), then 204.

Target time is under 150 ms p95.

## Multi-tenancy / trust boundary

The household always comes from the credential, never from a request parameter. The RLS GUC is set
per transaction, and queries also filter explicitly. Cross-household requests get 404. See
[ADR-0003](decisions/ADR-0003-household-scoping-app-plus-rls.md).

## Auth & authorization

| Principal | Credential | Where checked |
|---|---|---|
| Device | `fnh_device` httpOnly cookie (hashed with pepper in `devices.token_hash`) | `CurrentDevice` |
| Admin/host | `fnh_session` httpOnly cookie after magic link (15-min single-use link) | `CurrentAccount` |

Both credentials are resolved to `(id, household_id)` by the ADR-0009 definer functions before
any household transaction opens; everything after runs under RLS.

**Account sessions.** `POST /auth/magic-link` always answers 202 with the same body; the email
(a 256-bit, hash-stored, 15-minute, single-use link to `FRONTEND_BASE_URL/auth/callback`) goes out
in a background task after the response, so known and unknown addresses look alike. Requests
are budgeted per address (`MAGIC_LINK_REQUEST_LIMIT`, default 5 per 15 min), counting every
request. `POST /auth/verify` consumes the link with `UPDATE ... WHERE used_at IS NULL
RETURNING`, so two tabs racing one link sign in once. The session is a **signed, stateless**
`fnh_session` cookie (`{account}.{household}.{issued_at}` + HMAC-SHA256 under
`SESSION_SECRET`, 30 days, `HttpOnly; Secure; SameSite=Lax`). `CurrentAccount` re-reads the
account on every request, so disabling an account or changing its role takes effect
immediately. Trade-off: one stolen session can't be revoked on its own; disable the account or
rotate `SESSION_SECRET` (which signs everyone out). Revisit with a sessions table if that ever
matters. The first admin is created by `python -m app.cli bootstrap` (`app/cli.py`).

The permission map (`core/permissions.py`) is the single source of truth. Hosts get
`sessions:run`, `ballots:proxy`, `devices:enroll` and `devices:approve`; admins get everything;
unknown roles get nothing. Routes declare `Depends(require_permission("..."))`. Join flow rules are in
[ADR-0002](decisions/ADR-0002-device-identity-and-join-flow.md). Cookie-authenticated mutations,
and the join itself, require `SameSite=Lax` plus a CSRF header: `X-FNH-CSRF` must equal the
readable `fnh_csrf` cookie that `GET /api/v1/csrf` issues (double-submit, constant-time compare).

**Join.** The slug is a door, not a key. `POST /api/v1/join` resolves the slug (ADR-0009), then
looks for a non-closed session whose `night_code_hash` matches
`HMAC(pepper, "night:{household_id}:{code}")`. Codes are 6 characters from a 31-symbol alphabet
without 0/O/1/I/L (`domain/night_code.py`), case- and separator-insensitive. Every failure
(unknown slug, malformed, wrong, closed) returns the same 400, so the endpoint does not reveal
which slugs exist. A phone that already holds a live token for the household reuses its device.
The other way in is a signed-in host: `POST /devices/enroll` mints a device for that browser
(reusing one it already holds for the household). With `as_tv: true` the device is marked
`is_tv` and the host's `fnh_session` is cleared, so the living-room TV never carries host rights.
Approving a pending claim leaves the person bound to their other phone as well.
The device cookie is `fnh_device`: 256-bit token, `HttpOnly; Secure; SameSite=Lax`, 365-day
sliding `Max-Age`.

**Rate limiting.** Join *failures* are counted per slug (`JOIN_FAILURE_LIMIT` per
`JOIN_FAILURE_WINDOW_SECONDS`, default 30 per 15 min), never per client IP: a family shares one
NAT address, and forwarded headers are spoofable (uvicorn does not trust them). Once a slug's
budget is spent, joins get 429 with `Retry-After`, even with the right code, until the window
ends; successful joins cost nothing. A host-approved join is the fallback if someone burns the
budget on purpose. If Redis is down the limiter fails open and logs.

## Nights and the shortlist

`services/session_service.py` loads, locks (`SELECT … FOR UPDATE` on the session row, so racing
hosts serialize) and persists; the rules are pure functions in `domain/session_state.py`.

- **Create** (`POST /sessions`) starts a `draft` night owned by the signed-in host. The night code
  (`domain/night_code.generate`) is in the response **once**; only
  `HMAC(pepper, "night:{household}:{code}")` is stored. A collision with another live night of
  the household (unique index) is retried in a savepoint.
- **Rotate** (`POST /sessions/{id}/night-code`) issues a new code, shown once; the old one stops
  joining immediately, phones already in keep their device cookie. Allowed until `closed`.
- **Shortlist** (`draft` only, else 409): add by library `movie_id`, by `tmdb_id` (upserts the
  household's `movies` row from `/movie/{id}`; an id already in the library needs no TMDB call),
  or by typed `title` (+ optional `year`; a `movies` row without `tmdb_id`, reused for the same
  title/year). `source` is `owned` for owned titles, `tmdb` for TMDB-backed ones, else `manual`.
  At most 8 options; the same movie twice is 409. Remove renumbers positions; reorder
  (`PUT …/options/order`) must list every option exactly once. Each edit returns the snapshot.
- **Snapshot** (`GET /sessions/{id}`) is readable by any device of the household (`ViewerDb`
  slides the device cookie as usual) or account: status, voting method, `ballot_size` (null in
  `draft`), options with title/year/poster, timestamps, and `result`. Never ballots; `result`
  (ranking, winner, tie group, seed) is null until the night is revealed
  ([ADR-0004](decisions/ADR-0004-sse-live-updates.md), [ADR-0006](decisions/ADR-0006-voting-rules-and-tie-break.md)).
- Errors: other household or unknown id → 404; wrong state or limits → 409 with a host-readable
  reason; device-only caller on a host route → 401, an account without `sessions:run` → 403.

Audit actions (`audit_events`, `target_type = 'session'`): `session.created`,
`session.code_rotated`, `session.option_added`, `session.option_removed`, `session.reordered`,
`session.voting_opened` (`data` records from/to, option count, ballot size),
`session.voting_closed` (from/to, ballot count, winner, which tie-break decided),
`session.settled`, `session.closed`, and `ballot.proxy_cast` (`data` is the person only, never
the ranks).

## Voting

The session state machine (`domain/session_state.py`):
`draft → voting → revealed → tonight → closed`, as a transition table (`transition(status,
action)` refuses anything else; `closed` is terminal). `open_voting` needs 2–8 options and fixes
`ballot_size = min(3, n − 1)` with `voting_opened_at`. Every transition goes through one service method
that writes an audit row. `close_voting` runs the tally module, then the tie-break, then stores
`ranking jsonb`, `tie_seed` and `winner_option_id` in one transaction
([ADR-0006](decisions/ADR-0006-voting-rules-and-tie-break.md)). `revealed → tonight` is lazy: the
snapshot reports `tonight` once `revealed_at` is 30s old, and the next write persists it (no timer):
every host write locks the row through `session_service._lock`, which applies
`session_state.settle` and audits `session.settled`. Reads never write.

**Tally** (`domain/voting/`, pure, 100% covered). `base.py` defines `tally(options, ballots, *,
seed) -> Ranking`; `top3.py` is the v1 method. A ballot ranks 1..m options, `1 ≤ m ≤ k`, with no
gaps (rank 1 alone is fine); rank r is worth `k − r + 1`. The full order is: points, then (1) most
first-place votes, (2) head-to-head among the options still level (one win per rival that more
ballots rank it above than below; unranked counts as below every ranked option), then (3) a
lottery drawn from `random.Random(seed)` over the option ids in sorted order, so neither ballot
order nor shortlist order can change the result. `Ranking` records every placement (place,
points, first places), the tie group (options level with the winner on points before tie-breaks)
and which step decided the winner (`none`, `first_places`, `head_to_head`, `random`). Zero ballots
is a full tie decided by the seed. Hypothesis properties cover winner-is-shortlisted, ballot and
shortlist order independence, seed reproducibility, partial ballots and zero ballots.

**Ballots** (`services/ballot_service.py`, `api/v1/ballots.py`). `PUT …/ballots` from a phone
needs an **active** binding to the person (`people_service.require_can_act_as`; a pending
claim or another phone's person is 403). `PUT …/ballots/proxy` is for hosts with `ballots:proxy`
and stores `cast_by_account_id`, `is_proxy = true`. Both need status `voting` (else 409),
validate against k (else 422) and replace the person's rows in the request's transaction. The
session row is read `FOR SHARE`, so a ballot and `close_voting` (`FOR UPDATE`) serialize: a ballot
either lands before the tally or sees `revealed` and gets 409. `GET …/voters` (any device or
account) lists who has voted as person id, avatar emoji and colour; `GET …/ballots/mine` returns
the ballots of the people actively bound to the calling phone. Nothing returns anyone else's
ranks.

**Close and reveal.** `POST …/close-voting` (`sessions:run`) locks the row, and on `voting`
tallies, stores ranking/seed/winner, sets `revealed` and `revealed_at`, and audits. On
`revealed`/`tonight`/`closed` it is a no-op that returns the stored result, so a double tap or two
hosts racing yield one result (a racing close waits on the row lock, then sees `revealed`). The
seed is `secrets.randbits(64)`; with `ENVIRONMENT=test` only, the `X-FNH-Test-Seed` header pins it
(it is not in the OpenAPI contract, and is ignored in every other environment). The snapshot's
`result` carries the placements, winner, tie group, tie-break step and the seed as a decimal
string (64 bits overflow a JS number). `POST …/close` moves `tonight → closed` (idempotent;
`revealed` that hasn't settled yet is 409) and releases the night code.

**History.** `GET /sessions?status=…&limit=…` (any device or account) lists nights newest first
with the winner's title/year/poster, dates and turnout (people with a ballot). The default
filter is `revealed`, `tonight`, `closed`; filtering uses the status readers see, so a settled
reveal counts as `tonight`. A winner appears only once a night's status is revealed or later.

## Live updates

[ADR-0004](decisions/ADR-0004-sse-live-updates.md). Code: `app/realtime/` (`events.py`,
`tickets.py`, `publisher.py`) and `app/api/v1/stream.py`, adapted from OrderUp
`backend/app/realtime/` and `api/v1/portal/sse.py` @ 2f86cd8.

**Tickets.** `POST /api/v1/sse-tickets {session_id}` (any device or account of the
household, CSRF-protected) returns `{ticket, expires_in: 60}`; another household's or an
unknown night is 404. The ticket is 256 random bits stored at `sse_ticket:{ticket}` with the
household and night, 60s TTL (and an `exp` stamp checked against an injectable clock), and is
consumed with `GETDEL`, so it opens exactly one stream.

**Stream.** `GET /api/v1/sessions/{id}/stream?ticket=` consumes the ticket before any
response starts; a missing, used, expired or other-night ticket is 401 (and is burned). The
channel comes from the ticket's night only. The response is `text/event-stream` with
`Cache-Control: no-cache, no-transform` (keeps the Next proxy from gzip-buffering it, see
02-environments) and `X-Accel-Buffering: no`. It sends `: connected` right after
subscribing, `: heartbeat` after 15s of quiet, and ends after 30 minutes so the client
re-tickets. If Redis fails it sends a `degraded` frame and ends.

**Events.** Unnamed `data:` frames, so `EventSource.onmessage` sees all of them:
`{"type", "session_id", "version"}` and nothing else. The stream rebuilds each frame from
those three fields, so a stray field a publisher added can't reach a phone. `version` is a
per-night counter (`INCR live_version:{id}`) for spotting duplicates and gaps; it is not a
snapshot version. Every event is a hint: clients refetch `GET /sessions/{id}` (or
`…/voters`).

| Type | Published by |
|---|---|
| `shortlist_changed` | add, remove, reorder an option |
| `status_changed` | open voting; close the night |
| `ballot_count` | any ballot cast or replaced (phone or proxy) |
| `revealed` | close-voting when it actually tallies (not the idempotent repeat) |
| `photo_added` | registered for the photos slice |
| `degraded` | the stream itself, never published |

The lazy `revealed → tonight` settle publishes nothing: readers already see `tonight`. The
worker's stale-night auto-close doesn't publish either (nobody is watching a day-old night).

**After commit.** Services call `publish_after_commit(db, session_id, type)`, which queues
a hook on the session (`core/database.after_commit`); `household_session` runs the hooks
only once its transaction has committed, so a refetch triggered by the hint sees the new
state and a rolled-back write publishes nothing. Publishing is best-effort: a Redis failure
is logged and never fails the request. An unregistered type raises (a typo would otherwise
fail silently forever).

**Disconnects.** Phones drop streams constantly, so no subscription may outlive its client.
Under ASGI spec < 2.4 Starlette cancels the generator mid-await; its cleanup
(`UNSUBSCRIBE`, close) runs in a shielded cancel scope. Under 2.4 Starlette abandons the
generator after a failed send; `LiveStreamResponse` closes it. The request-ID middleware is
pure ASGI for the same reason. Tests drive the route as a raw ASGI client
(`tests/integration/live_stream.py`) and check `PUBSUB NUMSUB` after hanging up in both
modes.

## Candidates

Phase 1: the host types a title, `tmdb/search` proxies TMDB (cached), and picking a result upserts
a `movies` row. Phase 2: `domain/generator.py` per
[ADR-0007](decisions/ADR-0007-candidate-generator-order.md), with an injected RNG.

`integrations/tmdb.py` is HTTP and parsing only (httpx, `Authorization: Bearer
TMDB_READ_TOKEN`, `TMDB_TIMEOUT_SECONDS`); it reads `TMDB_BASE_URL` so dev and CI point it at
the fake. `services/movie_service.py` owns the cache: responses go into the global `tmdb_cache`
keyed by path + sorted params (search queries are whitespace-collapsed and case-folded), served
for 30 days, then refetched; if the refetch fails, the stale entry is served. With no token, or
TMDB down and nothing cached, search and add-by-`tmdb_id` answer **503** with a message telling
the host to type the title, and typed titles keep working.

**tmdb-fake** (`backend/tmdb_fake/`, compose service `tmdb-fake` on `localhost:58100`) serves
`/search/movie` and `/movie/{id}` from `fixtures/movies.json` in TMDB v3 response shapes (fake
poster paths), wants a Bearer token and 404s unknown ids like TMDB. Tests mount it in-process
via `httpx.ASGITransport` (`tests/integration/tmdb_doubles.py`, which also has "down" and
"unconfigured" doubles). CI never calls the real API.

## Where business logic belongs

Routers parse input and call services. Services own transactions, authorization of the target
record, and events. `domain/` is pure: no I/O, 100% coverage. Integrations wrap HTTP and S3.

## What's intentionally **not** here

- No WebSockets and no GraphQL.
- No server-side image processing in v1 ([ADR-0005](decisions/ADR-0005-photo-pipeline-and-storage.md)).
- No account system for members. No OAuth providers.
- Approval and pick-one voting modules ship in Phase 2.
