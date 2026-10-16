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
| Sessions | `/api/v1/sessions` | Create, shortlist, open/close voting, snapshot |
| Ballots | `/api/v1/sessions/{id}/ballots` | Upsert own ballot; host proxy ballot |
| Live | `/api/v1/sse-tickets`, `/api/v1/sessions/{id}/stream` | [ADR-0004](decisions/ADR-0004-sse-live-updates.md) |
| Photos | `/api/v1/sessions/{id}/photos` | Presign, complete, list (presigned GETs), react, hide/delete |
| Ratings | `/api/v1/sessions/{id}/ratings` | 1–5 per person, once the night is `tonight`/`closed` |
| Movies | `/api/v1/movies`, `/api/v1/tmdb/search` | Library, owned flag, TMDB search proxy |
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
5. It publishes `ballot_count` to `session:{id}`.
6. Commit, then 204.

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

## Voting

The session state machine (`domain/session_state.py`):
`draft → voting → revealed → tonight → closed`. Every transition goes through one service method
that writes an audit row. `close_voting` runs the tally module, then the tie-break, then stores
`ranking jsonb`, `tie_seed` and `winner_option_id` in one transaction
([ADR-0006](decisions/ADR-0006-voting-rules-and-tie-break.md)). `revealed → tonight` is lazy: the
snapshot reports `tonight` once `revealed_at` is 30s old, and the next write persists it (no timer).

## Live updates

The Redis channel `session:{id}` carries `{type, session_id, version}`. `stream.py` subscribes and
forwards events, sends a heartbeat every 15s, and closes after 30 minutes so clients re-ticket.
Events never carry ballots or tallies before reveal.

## Candidates

Phase 1: the host types a title, `tmdb/search` proxies TMDB (cached), and picking a result upserts
a `movies` row. Phase 2: `domain/generator.py` per
[ADR-0007](decisions/ADR-0007-candidate-generator-order.md), with an injected RNG.
`integrations/tmdb.py` reads `TMDB_BASE_URL` so CI points it at the fake.

## Where business logic belongs

Routers parse input and call services. Services own transactions, authorization of the target
record, and events. `domain/` is pure: no I/O, 100% coverage. Integrations wrap HTTP and S3.

## What's intentionally **not** here

- No WebSockets and no GraphQL.
- No server-side image processing in v1 ([ADR-0005](decisions/ADR-0005-photo-pipeline-and-storage.md)).
- No account system for members. No OAuth providers.
- Approval and pick-one voting modules ship in Phase 2.
