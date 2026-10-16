# 07 — CI/CD

`ci.yml` exists with the `static`, `unit`, `integration`, `contract`, `bundle-secrets` and `e2e`
jobs (status column below), and `deploy.yml` is built (below). Multi-phone voting, host + TV,
the photo drop, live updates (SSE), the TV slideshow and the Phase 1 acceptance journey in `e2e` are built. It combines OrderUp's
Fly deploy with CAD's "secret never in bundle" and multi-browser Playwright gates. The owner is a
QA/CI engineer, so the bar is **deterministic, trustworthy green**.

## The full pipeline at a glance

```mermaid
flowchart TB
    PR["push / PR"] --> S["static: ruff, mypy, eslint, prettier, tsc"]
    PR --> U["unit: pytest unit + domain 100% + vitest"]
    PR --> I["integration: pytest vs Postgres+Redis+SeaweedFS services (incl. isolation + RLS coverage)"]
    S & U & I --> E["e2e: docker compose (api, worker, web, tmdb-fake, seaweedfs) → Playwright multi-phone + axe"]
    E -- "all green" --> M["merge to main"]
    M --> B["build images → GHCR"] --> ST["deploy staging (release_command migrates)"] --> SM["smoke: /api/health + scripted join/vote"] --> G["manual approval"] --> P["deploy prod (same digest)"]
```

## CI jobs

| Job | Purpose | Source of truth | Status |
|---|---|---|---|
| `static` | ruff check + format, mypy strict, repo rules (`backend/scripts/check_repo_rules.py`: no sleeps/fixed waits in tests, no session-level `app.*` GUC, revision ids of 32 chars or fewer), actionlint 1.7.7 over every workflow, `tsc --noEmit`, eslint (`eslint-config-next`, run from `frontend/tools/eslint/`), prettier --check | `.github/workflows/ci.yml` | Built |
| `unit` | pytest `tests/unit` (+ Hypothesis tally properties), vitest (API client CSRF + error envelope, night-code input, ballot reducer; the live-stream state machine `src/lib/live.ts` at 100%: re-ticket, backoff, wake, poll only while down, except a `revealed` night, which polls until it settles into `tonight`; later the photo pipeline incl. GPS-strip fixture) | `backend/tests/unit`, `frontend/src/**/*.test.ts` | Built (photo-pipeline vitest lands with the pipeline) |; the photo pipeline's **GPS strip**: `frontend/e2e/fixtures/gps.jpg`, GPS-tagged, goes through `processPhoto` with a real JPEG encoder (`@napi-rs/canvas`) and exifr must find no GPS IFD, no EXIF and no APP1 `Exif` segment in either output; the upload queue's parallelism, retry/backoff and resume with fake timers; the IndexedDB job store; upload error sorting; album URL reuse inside the 10-minute TTL; the TV slideshow's scheduling `src/lib/slideshow.ts` at 100%: queue order with jump-the-queue, pause, step, skip, TTL-driven refresh) | `backend/tests/unit`, `frontend/src/**/*.test.ts` | Built |
| `integration` | Whole pytest suite against Postgres + Redis service containers as `fnh_app`, after the role bootstrap. **Includes the isolation suite** (two seeded households, every table) and `test_rls_coverage`. Coverage gates run here | `backend/tests/integration` | Built. SeaweedFS service joins with the photo endpoints; endpoint-level isolation joins with the endpoints |
| `contract` | `alembic upgrade` → `downgrade base` → `upgrade` round trip, `alembic check` (models match migrations), `openapi.json` + `api.gen.ts` drift | ci.yml | Built |
| `e2e` | Postgres + Redis + MailHog service containers, role bootstrap + migrations, `next build`, then Playwright starts uvicorn and `next start`. Phone viewports (Pixel 7, and iPhone 13 on Chromium) with axe (WCAG 2.1 AA): join with the night code → pick an avatar, wrong code, lookalike characters, cookie redirects, magic-link request → emailed link → `/host` → sign out, bad and replayed tokens. Voting (`voting.spec.ts`): two phone contexts each vote for their own people (one phone shared by two people, with "Pass to next person"), the host closes through the API with `X-FNH-Test-Seed`, and both phones show the same winner; `/history` shows it with turnout; a phone can't vote for someone bound to another phone (pending claim, forced API call, and a stale ballot showing the server's message); a draft night says "Almost ready". Host + TV (`host-tv.spec.ts`): a TV context (1280×720) where the host starts a night and pairs it as the TV (code handed off in-tab), the host's phone builds a shortlist (forced TMDB 503 → typed titles; add, reorder, remove, reload) and opens voting, a phone joins and votes, a proxy vote, close with `X-FNH-Test-Seed`, TV turnout tiles light and the reveal lands on the stored winner; a paired TV asking for the code; `/tv` unpaired. Photos (`photos.spec.ts`, against a real S3 bucket: SeaweedFS 3.97 started as a step with `infra/seaweedfs/s3.json`, and `frontend/e2e/setup_bucket.py` creating the bucket plus its CORS rule for the web origin): a phone adds the GPS-tagged JPEG **and HEIC** fixtures (Chromium can't decode HEIC, so this exercises the `heic-to` worker fallback); the test fetches what landed in the bucket through the presigned URLs and asserts JPEG, no GPS, no EXIF; a second phone sees both on `/albums/[session]`, opens the viewer (uploader's name) and reacts, and the first phone sees the count; the first PUT to the bucket is dropped once and the queue's retry still lands the photo; and an **unauthenticated context gets 0 photo URLs** (every API answer it receives is read through a route and none contains a presigned signature, `GET …/photos` is 401, no `<img>` on the page). Live updates (`live.spec.ts`, ADR-0004): two phones and a paired TV all wait for `data-live="ready"`, then each ballot shows on the TV's turnout ("1 of 3 voted") and the host's close shows the winner on both phones and the TV within 4s, which only the stream can deliver since nothing polls while it's up; and a phone whose stream is killed mid-vote (an init script drops its `EventSource` the way the browser reports a lost stream, while `page.route` aborts reconnects) shows `reconnecting`, still gets the reveal by polling, then goes back to `ready` when the route is unblocked and the network blips. **Phase 1 acceptance** (`acceptance.spec.ts`, BUILD-PROMPT "4 phones and a TV complete a night with photos"; runs once, under the `pixel` project, since it opens its own iPhone 13 and Pixel 7 contexts): the host signs in on the TV's browser by the emailed link (MailHog) and pairs it, signs in on their phone by a second link, starts the night, types the code on the TV, builds a 4-title shortlist and opens voting; four phones join at `/j/{slug}` with the code the TV shows, one shared by two people, one claiming someone already on another phone (the host approves on `/host`); everyone ranks posters and the host proxy-votes for a child, each ballot lighting its TV tile within 4s (stream, not poll); the host closes with `X-FNH-Test-Seed` and the TV and all four phones show the same winner; the reveal settles into `tonight` with no reload; two phones add the JPEG and HEIC fixtures, a third sees both and reacts, the host hides one and every phone drops it; a never-joined browser gets 0 photo URLs; `/history` lists the night; axe on each distinct screen. Adding people and hiding a photo go through the API (no UI until Phase 2). What CI can't prove before the first real night is in [`runbooks/phase1-acceptance.md`](../runbooks/phase1-acceptance.md). Ratings (`ratings.spec.ts`): during `tonight` the stars stay folded behind "Rate it now"; the host closes the night through the API, `/who` then shows "How was *Movie*?", and two people on one shared phone each tap their stars until the panel shows "Family average: 4.5 from 2 ratings" and `/history` shows the same; then the card is gone. Candidate generator (`generator.spec.ts`, ADR-0007, against **tmdb-fake**, which Playwright starts as a third web server, with the API's `TMDB_BASE_URL`/`TMDB_READ_TOKEN` pointed at it): the host rolls 4 Family titles and gets the two owned library titles first, then Disney Plus titles badged "Streaming on Disney Plus" with the JustWatch line from the response; adds the owned one and a streaming one (each through the shortlist endpoint with its source), re-rolls (the shortlisted title is gone), and opens voting; with TMDB down (the real answer rewritten through `page.route`) only owned titles roll under "TMDB unavailable, owned titles only." and Add stops at 8 titles. A pending claim on `/who` flips to `mine` once the host approves it on `/host`, with no reload (`voting.spec.ts`; the acceptance journey no longer reloads either). TV slideshow (`tv-slideshow.spec.ts`, real bucket): a paired 1280×720 TV on a `--tonight` night shows "Drop your photos from your phone", then a phone's upload appears on it with no reload (the stream's `photo_added`), image loaded, alt "Photo from Ava, {date}", caption and count; a second phone's upload jumps the queue; space shows "Paused" and the arrows step; the host hides the photo and the TV drops it on its next album sweep; no presigned URL anywhere in the DOM outside `<img src>` or in the console; under `reducedMotion: "reduce"` the photo has no pan animation (and has one again without it); axe on the idle, playing and paused screens. **Admin** (`admin.spec.ts`; runs once, under the `pixel` project, with its own laptop-sized admin context and a Pixel 7 phone): from `/host` the admin opens `/admin/people`, adds a guest and makes them family, gets the API's 409 for a duplicate name, adds a second person a phone then claims, and merges that duplicate into the first through the confirm dialog ("Moved 1 phone to …"; the phone's grid now holds the target and the duplicate is gone); on `/admin/devices` the phone shows its person and a last-seen time, is renamed, then revoked through the "final" confirm, and the phone's `/who` says it hasn't joined; on `/admin/settings` the join link is rotated through the fridge-QR warning, the old `/j/{slug}` refuses the night code and the new one lets the phone back in as a new device; the age cap is saved; two streaming services are picked from tmdb-fake (JustWatch and TMDB attribution shown) and survive a reload; axe on each screen and each confirm dialog. A host-role account (`--host-account`) gets 403 from each admin API and an "Admins only" panel on each screen, and `/admin` without a session goes to `/login`. Each test seeds its own household (`frontend/e2e/seed_night.py`; `--movies N --open-voting` gives a night in voting, `--tonight` a night whose album is open, `--no-night` the household and people only, `--host-account` a second, host-role account, `--owned N --providers 337` owned library titles and streaming services for the generator, plus a signed host session cookie). | `frontend/e2e/` | Built (join + sign-in + phone voting + host/TV + photo drop + live updates + TV slideshow + **Phase 1 acceptance** + candidate generator + admin) |
| `bundle-secrets` | `next build` with sentinel values for every server secret, then grep `.next/static` for each. Verified by a deliberate leak (`next.config` `env` + client component) that the grep catches | ci.yml | Built |

`ENVIRONMENT=test` in CI. TypeScript types come from `openapi-typescript`, installed in its own
package (`frontend/tools/openapi/`) because it needs a TypeScript 5 peer and the app runs
TypeScript 7.

**Coverage / quality gates:** `app/domain/**` at 100% line coverage, services at 80% or more,
overall at 70% or more (all three enforced in the `integration` job), with ratchets that only go up. Any test using `waitForTimeout` or `sleep`
fails lint. E2E retries = 0 on PRs. A flaky test is quarantined with an issue, never retried into
green.

**E2E determinism rules:** wait for `data-live="ready"` before acting; assert on server-derived
text with `expect.poll`/`toHaveText`; tie-break seeds are injected through a test-only header that
is accepted only when `ENVIRONMENT=test`; TMDB is always `tmdb-fake` (Playwright starts it on
`E2E_TMDB_PORT`, default 8202, and points the API it starts at it; `host-tv.spec.ts` still forces
the search's 503 with `page.route` to cover the typed-title path). While
`data-live="ready"` no screen polls, so `live.spec.ts` asserts updates within 4s (under one 5s
poll); specs that can tolerate a dropped stream wait up to 15s (one poll plus margin).

## Running E2E locally

Use a database of your own so parallel work never collides (the shared compose Postgres is on
`localhost:55432`, MailHog's API on `58025`):

```bash
docker exec fnh-db-1 createdb -U fnh fnh_e2e
docker exec -i fnh-db-1 psql -U fnh -d fnh_e2e -v ON_ERROR_STOP=1 < backend/db/init/00-init-app-role.sql
(cd backend && MIGRATION_DATABASE_URL=postgresql+psycopg2://fnh:fnh@localhost:55432/fnh_e2e uv run alembic upgrade head)
cd frontend && npx playwright install chromium
DATABASE_URL=postgresql+asyncpg://fnh_app:fnh_app@localhost:55432/fnh_e2e REDIS_URL=redis://localhost:56379/5 EMAIL_MODE=smtp SMTP_PORT=51025 FRONTEND_BASE_URL=http://localhost:3201 MAILHOG_URL=http://localhost:58025 npm run test:e2e
```

Playwright also starts tmdb-fake (`uv run uvicorn tmdb_fake.app:app`) on `E2E_TMDB_PORT` (default
8202) and gives the API it starts `TMDB_BASE_URL`/`TMDB_READ_TOKEN` for it. If you run your own API
instead (reused outside CI), export those two yourself.

The photo tests also need the shared SeaweedFS (`localhost:58333`) and a bucket of your own with a
CORS rule for your web origin. Export these alongside the variables above (for `npm run test:e2e`
as well as for this one-off setup):

```bash
export STORAGE_ENDPOINT=http://localhost:58333 STORAGE_ACCESS_KEY_ID=fnh-dev-access STORAGE_SECRET_ACCESS_KEY=fnh-dev-secret STORAGE_REGION=us-east-1 STORAGE_BUCKET=fnh-photos-e2e
(cd backend && uv run python ../frontend/e2e/setup_bucket.py --origin http://localhost:3201)
```

Playwright starts uvicorn (`E2E_API_PORT`, default 8201) and `next dev` (`E2E_WEB_PORT`, default
3201), or reuses them if they are already running with the same env. Without `MAILHOG_URL` the
emailed-link test is skipped. Chromium only: the API's cookies are `Secure`, and Chromium is the
engine that keeps them on `http://localhost`.

## Deploy workflow

`.github/workflows/deploy.yml` runs when **CI completes successfully for a push to `main`**
(`workflow_run`), not on the push itself, so a main commit whose CI failed is never deployed. It
can also be run by hand (`workflow_dispatch`) after provisioning.

1. **build** (matrix): one image for api + worker (`backend/`), one for web (`frontend/`). Both are
   pushed to GHCR as `ghcr.io/<owner>/fnh-{backend,web}:sha-<commit>`, and each digest is handed
   on as an artifact.
2. **deploy-staging** (GitHub environment `staging`): set the photos bucket's CORS rule for the
   web origin (`deploy/bucket-cors.sh`, below), pull both images **by digest**, then
   `flyctl deploy --image … --local-only` for `fnh-api-staging` (its `release_command` runs
   Alembic before new machines start; `--no-public-ips`), `fnh-worker-staging` and
   `fnh-web-staging`, in that order. Then the smoke test: `GET
   https://fnh-web-staging.fly.dev/api/health` must return `status: ok`, which exercises web →
   Flycast → api → Postgres (RLS path) + Redis. The scripted join/vote smoke lands with e2e.
3. **deploy-production** (GitHub environment `production`, required reviewer): the **same
   digests**, through the same steps with `deploy/prod/*`.

`--local-only` pushes from the runner's Docker daemon to Fly's registry, so Fly never needs GHCR
credentials (OrderUp pattern). Rollback means redeploying the previous `sha-<commit>` image
without the release command ([runbook §3](../runbooks/restore.md#3-roll-back-a-deploy)).
Migrations are expand/contract, so rolling back code never needs a down-migration.

**CI disabled means no automatic deploy.** The trigger is CI completing on a push, so nothing
deploys while `ci.yml` is disabled. A `workflow_dispatch` run of CI doesn't count either, since its
event isn't `push`. Run Deploy by hand
([`first-deploy.md`](../runbooks/first-deploy.md) step 10). `setup-flyctl` is pinned to a commit
SHA because its job holds `FLY_API_TOKEN`.

**Inert until provisioned.** Each deploy job reads `FLY_API_TOKEN` from its environment. If it is
empty, the job emits a notice and skips its steps instead of failing `main`, and production then
skips too. **Give `production` its required reviewer before adding its token.** GitHub creates a
referenced environment without protection rules.

**Photos bucket CORS.** `deploy/bucket-cors.sh deploy/<env>/api.fly.toml` runs before the Fly
deploys and is the Tigris twin of `frontend/e2e/setup_bucket.py`: it `put-bucket-cors` the rule
phones need (origins = that environment's `CORS_ALLOWED_ORIGINS`, each checked to be a bare
`https://` origin; methods `PUT`, `GET`; header `content-type`; max age 600), then reads it back
and fails the job if it differs. Replacing the whole rule set makes it idempotent. It has its own
gate: `vars.PHOTOS_BUCKET` plus secrets `BUCKET_ADMIN_ACCESS_KEY_ID` /
`BUCKET_ADMIN_SECRET_ACCESS_KEY` on the environment. None set = a notice and a skip; some but not
all = the job fails, since a half-provisioned bucket is a mistake, not a choice. The admin key is
passed to that step alone (not the job's env), and it is never a Fly secret, so the API's own
bucket key never gains bucket-config rights. Production's CORS step sits in `deploy-production`,
so it runs only when that job does (staging deployed, reviewer approved).

## Secrets map

| Secret | Where stored | Consumed by |
|---|---|---|
| `FLY_API_TOKEN` (staging, prod) | GitHub environments `staging`, `production` | deploy.yml |
| `BUCKET_ADMIN_ACCESS_KEY_ID`, `BUCKET_ADMIN_SECRET_ACCESS_KEY` + variable `PHOTOS_BUCKET` (staging, prod) | GitHub environments `staging`, `production` | deploy.yml's bucket CORS step only |
| `GHCR` push | `GITHUB_TOKEN` | deploy.yml |
| App secrets | `fly secrets` (see [`02-environments.md`](02-environments.md)) | Fly apps |
| CI test secrets | none needed (local services, tmdb-fake) | — |

## What CI does NOT enforce

Worth knowing so you don't assume green means safe:
- Real iOS Safari HEIC behaviour. WebKit in Playwright is not iOS, so there is a manual iPhone checklist before each release that touches photos: [`runbooks/photo-drop-iphone-checklist.md`](../runbooks/photo-drop-iphone-checklist.md).
- That the deployed (Tigris) buckets' CORS rule actually lets a browser in. The deploy sets it and reads it back, but no browser preflight runs against Tigris; the iPhone checklist is where a phone PUT first crosses it.
- Live TMDB terms and parameter behaviour, because CI uses the fake. Last verified against developer.themoviedb.org on 2026-10-15 when the generator was built (summary in the generator PR); re-check before relying on a new parameter.
- Load, backup restore (rehearsed manually), and keeping the docs in sync with the code.
