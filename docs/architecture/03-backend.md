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
| Photos | `POST/GET /api/v1/sessions/{id}/photos`, `POST …/photos/{pid}/complete`, `PUT/DELETE …/photos/{pid}/reactions/{emoji}?person_id=`, `POST …/photos/{pid}/{hide,unhide}`, `DELETE …/photos/{pid}` | Device: presign, complete, react (as a bound person). Album: any device or account. Hosts hide/unhide (`sessions:run`), admins hard-delete (`admin:photos`). See "Photos" below |
| Ratings | `PUT /api/v1/sessions/{id}/ratings`, `PUT …/ratings/proxy`, `GET …/ratings/mine` | 1–5 per person, once the night is `tonight`/`closed`: a phone rates as its bound people, a host proxy-rates (`ballots:proxy`), a phone reads back its own people's scores. See "Ratings" |
| Movies | `GET /api/v1/tmdb/search?q=` | TMDB search proxy for hosts (503 when TMDB is off or down). The library itself is admin-only (next rows) |
| Admin people | `GET/POST /api/v1/admin/people`, `PATCH /admin/people/{id}`, `POST /admin/people/{id}/convert-to-member`, `POST /admin/people/merge` | Add, rename/re-avatar/recolour, guest → member, merge (`admin:people`; hosts may add guests). See "People and devices admin" |
| Admin devices | `GET /api/v1/admin/devices`, `PATCH /admin/devices/{id}`, `POST /admin/devices/{id}/revoke` | The "Devices" list with each device's people, label, revoke (`admin:devices`) |
| Admin settings | `GET/PATCH /api/v1/admin/settings`, `POST /admin/join-slug/rotate` | Household defaults and the fridge-QR slug (`admin:settings`) |
| Admin movies | `GET /api/v1/admin/movies?q=&owned=&watchlist=&blocked=&limit=&offset=`, `PATCH /admin/movies/{id}`, `POST /admin/movies/bulk`, `POST /admin/movies/bulk/confirm` | Library search/filter/paginate, flags, bulk add of owned titles through TMDB search (`admin:movies`). See "Library and history admin" |
| Admin history | `POST /api/v1/admin/sessions/{id}/correct-winner` | Correct a past night's winner with a reason (`admin:history`); ranking and seed untouched. See "Library and history admin" |
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
`sessions:run` (which also lets them add a guest), `ballots:proxy`, `devices:enroll` and `devices:approve`; admins get everything;
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
`session.settled`, `session.closed`, `ballot.proxy_cast` (`data` is the person only, never
the ranks), and `rating.proxy_rated` (`data` is the person only, never the score).

## People and devices admin

All under `/api/v1/admin/*` (`app/api/v1/admin/`), account-only: a device cookie alone gets
401, a role without the permission 403, another household's id 404, and every mutation needs
the CSRF header and writes an audit row.

- **People** (`services/people_admin_service.py`, `admin:people`). Create takes `{name,
  avatar_emoji, color, is_guest}`. Names are whitespace-collapsed, 1–60 chars; the emoji is
  1–16 code points with no whitespace and at least one non-ASCII character (ZWJ families and
  keycaps pass, words don't); colour is `#rrggbb`, stored lowercase. **Names are unique per
  household among unmerged people, case-insensitively** (guests included), checked under a
  per-household advisory lock; a clash is 409 naming the existing person. A merged-away name
  is free again. Hosts (`sessions:run`) may create **guests only**; everything else here is
  admin-only. `PATCH` changes only the fields sent; `convert-to-member` clears `is_guest`
  (idempotent). A merged person is 404 to every admin route and drops out of every list.
- **Merge** (`POST /admin/people/merge {from_person_id, into_person_id}`). People are never
  deleted ([05-data.md](05-data.md) "Conventions"): in the request's one transaction both rows
  are locked in id order, every row naming the source is repointed to the target, and the
  source gets `merged_into_id`. Collisions with the target's own rows go the target's way, so
  the result never depends on row order:

  | Table | Unique key | Rule |
  |---|---|---|
  | `ballot_ranks` | (session, person, rank), (session, person, option) | In a night where the target has a ballot, the source's **whole** ballot is dropped (two partial ballots can't be mixed into a valid one); otherwise it moves |
  | `ratings` | (session, person) | Target's rating wins |
  | `photo_reactions` | (photo, person, emoji) | Duplicates collapse into the target's |
  | `device_people` | (device, person) | Target's row is kept, upgraded to `active` if either was |
  | `photos` | — | All move |

  The target keeps its own name, avatar, colour and guest flag. People previously merged into
  the source are repointed to the target, so `merged_into_id` is always one hop. Self-merge is
  409. The response and the `person.merged` audit row carry moved/dropped counts per table.
- **Devices** (`services/device_admin_service.py`, `admin:devices`). The list returns every
  device (live first, most recently seen first, then revoked) with label, `is_tv`,
  `last_seen_at`, `revoked_at` and its people with binding status. `PATCH` sets or clears the
  label. **Revoke** stamps `revoked_at`: the ADR-0009 resolver ignores revoked devices, so the
  cookie is 401 on its next request, its bindings stop counting as "taken" (the people are free
  to claim without approval) and its pending claims leave the review list. Bindings are kept for
  the record. Revoking twice changes nothing. **Revocation is final — there is no un-revoke**: a
  revoked phone rejoins with a night code (or a host enrollment) and becomes a new device, so a
  stolen token can never be brought back to life.
- **Settings** (`services/household_settings_service.py`, `admin:settings`). `GET` returns the
  join slug plus `default_voting_method`, `default_age_cap` and `region`; `PATCH` changes only
  the fields sent (`default_age_cap: null` clears the cap). Phase 1 accepts only `top3` as the
  voting method; age caps are `G`/`PG`/`PG-13`/`R`/`NC-17`; region is ISO 3166-1 alpha-2,
  stored uppercase. **Rotate join slug** issues a new `xxxx-xxxx-xxxx` slug from the night-code
  alphabet, lowercased (`domain/join_slug.py`, ~2^59 values; a unique-constraint clash retries
  in a savepoint). `/j/{old}` stops resolving immediately; devices already in keep working.

Audit actions: `person.created`, `person.updated` (`data.fields`), `person.converted_to_member`,
`person.merged` (`target_id` = the target), `device.relabeled`, `device.revoked`,
`settings.updated` (`data` = from/to of the fields sent), `household.join_slug_rotated` (no
slug values).

## Library and history admin

Both under `/api/v1/admin/*` with the admin rules above (device cookie 401, role without the
permission 403, other household 404, CSRF on every mutation, an audit row per write).

- **Library** (`services/library_service.py`, `api/v1/admin/movies.py`, `admin:movies`). `GET`
  lists the household's `movies` alphabetically: `q` is a case-insensitive title substring
  (`%`/`_` escaped), each of `owned`/`watchlist`/`blocked` filters when sent, `limit` 1–200
  (default 50) and `offset`; the response carries `total`. `PATCH /{id}` sets any of the three
  flags and audits `movie.updated` with from/to for the flags that changed (none changed → no
  row). The generator rolls `owned AND NOT blocked` first ([ADR-0007](decisions/ADR-0007-candidate-generator-order.md)).
- **Bulk add** (`POST /bulk {titles: [{title, year?}]}`, 1–100 lines; the UI parses "Title
  (year)" lines). Each line goes through `movie_service.search` (the global `tmdb_cache`, so a
  re-paste costs no TMDB calls) and `domain/library.classify`, which matches only when there is
  one sensible answer, because a wrong "owned" title skews every roll:
  a year first narrows results to that release year; then **one** result whose title equals the
  typed title (ignoring case, accents, punctuation and spacing) is `matched`, two or more
  (remakes) are `ambiguous`; with a year and one result left it is `matched` even if spelled
  differently; otherwise any results are `ambiguous` (top 5 candidates) and none is
  `not_found`. A match is upserted by TMDB id through `movie_service.upsert_from_tmdb`
  (details, so runtime/genres feed the generator's filters) and set `owned`; `already_owned`
  says it was owned before. **TMDB off or down**: that line and every later one is added as a
  typed title with no TMDB id (`added_manual`, reusing an existing typed row of the same
  title/year) and `tmdb_unavailable` is true; after the first failure no further line calls
  TMDB, so a hung TMDB costs one timeout, not one per line. `POST /bulk/confirm {picks:
  [{title, year?, tmdb_id?}]}` resolves the admin's answers: a `tmdb_id` is upserted and owned
  (a TMDB 404 comes back `not_found`; TMDB down → added as typed), no `tmdb_id` adds the title
  as typed. Both responses carry `attribution` (the TMDB notice). One audit row per call that
  owned something new: `movie.bulk_added` / `movie.bulk_confirmed` with per-status counts,
  the newly owned `movie_ids` and `tmdb_unavailable`.
- **Correct a winner** (`POST /admin/sessions/{id}/correct-winner {option_id, reason}`,
  `session_service.correct_winner`, `admin:history`). [ADR-0006](decisions/ADR-0006-voting-rules-and-tie-break.md):
  history stores the full ranking, so a correction is a re-close with an audit row. The
  session row is locked through `_lock` (which also persists a pending settle);
  `session_state.check_can_correct_winner` allows only `revealed`/`tonight`/`closed` (draft or
  voting → 409). The option must be on **this** night's shortlist (another night's option, an
  unknown id or another household's → 409; the composite FK on `(winner_option_id, id)` is the
  backstop), and must differ from the current winner (409). Only `winner_option_id` changes:
  `ranking` and `tie_seed` stay exactly as tallied, so the snapshot's `placements` still show
  how the family voted while `result.winner_option_id`, `/history` and the ratings average
  follow the correction. Reason: whitespace-collapsed, 1–500 chars. Audited as
  `session.winner_corrected` with `from_option_id`/`to_option_id`, both titles,
  `ranked_winner_option_id` (the tally's pick) and the reason; publishes `winner_corrected`.
  Never re-tallies. Returns the snapshot.

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

## Ratings

`services/rating_service.py`, `api/v1/ratings.py`. After the movie, each person scores it 1–5.
The table (`ratings`, unique (session, person), `check(score between 1 and 5)`) shipped in Phase 1.

- **Rate** (`PUT …/ratings {person_id, score}`, device, CSRF) needs an **active** binding to the
  person (`people_service.require_can_act_as`; a pending claim or another phone's person is 403
  "This phone can't rate as them"). **Proxy** (`PUT …/ratings/proxy`, `ballots:proxy`, CSRF) lets
  a host rate for anyone in the household (an unknown or merged person is 404). Each proxy rating
  writes a `rating.proxy_rated` audit row whose `data` holds the person only, never the score.
  Both are an upsert (`ON CONFLICT (session_id, person_id) DO UPDATE`): rating again replaces the
  score, and repeating it changes nothing.
- **When.** Ratings are accepted once the night's *effective* status is `tonight` or `closed`
  (`domain/session_state.check_can_rate`), so a reveal counts once it has settled (the lazy
  `revealed → tonight` rule). Earlier statuses are 409 "Ratings open once tonight's movie is picked".
  The session row is read `FOR SHARE`. The phone only *asks* after the movie (04-frontend.md), but
  the server doesn't refuse a rating given during it.
- **Reads.** `GET …/ratings/mine` returns `{person_id, score|null}` for each person actively bound
  to the calling phone. The snapshot and each history row carry `rating: {average, count}` (the
  family average, `average` null while `count` is 0), and only once the night is
  `tonight`/`closed` (`session_state.shows_rating`); before that `rating` is null. No endpoint
  returns another person's score.
- **Live.** Every rating publishes `rating_count` after commit, and screens refetch the snapshot.
- **For the generator.** `rating_service.average_ratings(db, movie_ids, since=None)` returns, in
  one query, the family's `RatingAverage(average, count)` for each library movie over the nights
  it won whose reveal (or creation) is at or after `since` (None: every night it won); a movie
  with no rating in that window has no entry. The generator passes its recent winners with no
  `since`, then applies ADR-0007's "skip titles watched in the last 12 months unless the average
  is 4 or higher". `average_rating(db, movie_id, since)` is the single-movie form (None when
  unrated). Both are household-scoped by the caller's RLS transaction.
- Other household's night → 404; a device on the proxy route → 401; an account without
  `ballots:proxy` → 403; a score outside 1–5 → 422.

## Photos

`services/photo_service.py` over `integrations/storage.py` ([ADR-0005](decisions/ADR-0005-photo-pipeline-and-storage.md)).
Photo bytes never touch the API.

- **Create** (`POST …/photos`, device, `{person_id, taken_on?}`): the person must be actively
  bound to the device (403), and the night's *effective* status must be `tonight` or `closed`
  (409 otherwise; a reveal counts once it has settled, `domain/session_state.check_photos_open`).
  Inserts a `pending` row with keys `households/{hid}/sessions/{sid}/{photo_id}.jpg` and
  `…_thumb.jpg` and returns two presigned PUTs (5 min, `Content-Type: image/jpeg` signed in, so
  the bucket refuses any other type). `taken_on` is the EXIF date, stored as midnight UTC. A
  night holds at most 500 photos (a runaway-queue backstop, 409).
- **Complete** (`POST …/{pid}/complete`): only the creating device (any other caller gets 404).
  HEADs both objects: present, `image/jpeg`, 1 byte–10 MB, else **422** and the row stays
  `pending` (the worker sweeps pending rows after 24h). Then `bytes` and `status = ready`.
  Idempotent. A presigned PUT cannot cap size, which is why this check exists.
- **Album** (`GET …/photos`, any device or account): `ready` photos newest first, each with
  uploader name/avatar/color, reaction counts, `my_reactions` (people bound to the calling
  device) and **fresh presigned GETs (10 min) minted per request after the household check**.
  Hidden photos are listed only for accounts with `sessions:run` (so they can unhide);
  devices and the TV never see them. No credential → 401 before any URL is minted.
- **Reactions** (`PUT/DELETE …/reactions/{emoji}?person_id=`): allowlist ❤️ 😂 😮 👍 🎉 🍿
  (422 otherwise), only on `ready` photos (404), only as a bound person (403). Both idempotent.
- **Moderation.** Hide/unhide is `sessions:run`: the host running the night in the room is the
  person who notices a bad photo, and hiding is reversible, so no new permission. Hard delete
  is `admin:photos` (admins only): one transaction writes the `photo_deletions` tombstone,
  deletes the row (reactions cascade), audits `photo.deleted`, then deletes both objects; a
  storage failure rolls it all back (503) and a retry is safe. The worker purges the backup
  copies from the tombstone. Audit actions (`target_type = 'photo'`): `photo.hidden`,
  `photo.unhidden`, `photo.deleted`.
- **Storage client.** boto3 (sync) — presigning is local CPU work; HEAD and DELETE run in
  `asyncio.to_thread`. Services depend on the `PhotoStorage` protocol; tests swap in an
  in-memory fake through the `photo_storage` dependency. `tests/integration/test_storage_s3.py`
  exercises the real client against SeaweedFS and is skipped unless `STORAGE_TEST_ENDPOINT` is set
  (CI has no S3 service yet). Unconfigured storage → photo routes answer 503.

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
| `photo_added` | a photo upload completes (`pending → ready`) |
| `rating_count` | a rating set or replaced (phone or proxy) |
| `winner_corrected` | an admin corrected the night's winner |
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

**Generator.** `POST /sessions/{id}/generate` (`sessions:run`, CSRF, draft only, else 409; another
household's night is 404) takes `{count 1–20, genre?, max_runtime?, age_cap?}` and returns
candidates **without adding them**. The host adds picks through `POST .../options`: `movie_id`
for owned titles (source `owned` is derived), `tmdb_id` + `source: "streaming"` or `"tmdb"`
otherwise. `services/generator_service.py` loads the inputs and calls the pure
`domain/generator.py`, which owns every rule:

- **Pools, in order, fetched lazily** (a later pool is only fetched while the roll is short):
  owned (`movies.owned`); streaming (`/discover/movie` with
  `with_watch_providers=<settings.streaming_providers, pipe = OR>`, `watch_region=<settings.region>`,
  `with_watch_monetization_types=flatrate`); anywhere (`/discover/movie` with `vote_count.gte=200`).
  Both discover pools read page 1, then one page drawn with the RNG within
  `min(total_pages, 50)` (TMDB rejects pages over 500). Each pool is shuffled with the RNG.
- **Filters:** genre (TMDB's 19 genre names; `with_genres` id in the query), max runtime
  (`with_runtime.lte`; list results carry no runtime, so an unknown runtime passes locally), and
  the **age cap**: the request's (explicit `null` = no cap tonight), else `sessions.age_cap`, else
  `settings.default_age_cap`. It goes in the query (`certification_country=US&certification.lte=`)
  **and** is re-checked locally against the US certification from
  `/movie/{id}/release_dates` (theatrical first; blank entries ignored). Local enforcement is
  load-bearing: TMDB orders `NR` at 0, so `certification.lte` returns NR titles. Unrated titles
  (no cert, `NR`, anything else unknown) never roll on a capped night.
- **History:** winners revealed in the last 12 months are skipped unless the family's average
  rating of that title (over every night it won) is 4 or higher; unrated means no rescue. The
  averages come from `rating_service.average_ratings` in one batched query for all recent winners
  (see Ratings, "For the generator").
  Blocked titles and titles already on the shortlist are always skipped; no duplicates across
  pools (a title is the same by TMDB id or library id).
- **Caching:** every TMDB response goes through `tmdb_cache` (30 days, stale-on-outage). A learned
  certification is also written to `movies.us_cert` on the household's row for that TMDB id
  (owned titles get theirs on their first capped roll; `upsert_from_tmdb` fetches it on add).
  Keys longer than the 300-character column are truncated plus a SHA-256 suffix.
- **Output:** title, year, poster, `source` (`owned`/`streaming`/`tmdb`), `us_cert`, runtime and,
  for streaming, the household's services it is on (`/movie/{id}/watch/providers`, flatrate).
  `attribution.tmdb` is always set and `attribution.justwatch` whenever streaming data is shown;
  the UI must display them. With TMDB off or down, owned titles still roll and
  `tmdb_unavailable` is true.
- **Determinism:** the RNG is `random.Random(seed)` with `secrets.randbits(64)`; tests pin it with
  `X-FNH-Test-Seed` (ENVIRONMENT=test only), so a roll is reproducible for a seed and cache state.

`GET /tmdb/providers` lists the streaming services TMDB knows in the household's region (for the
settings picker; JustWatch attribution included), and `PATCH /admin/settings` takes
`streaming_providers` (≤ 20 TMDB provider ids, replaces the list).

`integrations/tmdb.py` is HTTP and parsing only (httpx, `Authorization: Bearer
TMDB_READ_TOKEN`, `TMDB_TIMEOUT_SECONDS`); it reads `TMDB_BASE_URL` so dev and CI point it at
the fake. `services/movie_service.py` owns the cache: responses go into the global `tmdb_cache`
keyed by path + sorted params (search queries are whitespace-collapsed and case-folded), served
for 30 days, then refetched; if the refetch fails, the stale entry is served. With no token, or
TMDB down and nothing cached, search and add-by-`tmdb_id` answer **503** with a message telling
the host to type the title, and typed titles keep working.

**tmdb-fake** (`backend/tmdb_fake/`, compose service `tmdb-fake` on `localhost:58100`) serves
`/search/movie`, `/movie/{id}`, `/discover/movie`, `/movie/{id}/release_dates`,
`/movie/{id}/watch/providers` and `/watch/providers/movie` from `fixtures/*.json` in TMDB v3
response shapes (real genre and provider ids; poster paths and streaming availability are
illustrative). Discover applies the filters the way TMDB does, including the NR-is-0 cap order,
and pages over 500 fail with TMDB's error. It wants a Bearer token and 404s unknown ids like
TMDB. Tests mount it in-process
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
