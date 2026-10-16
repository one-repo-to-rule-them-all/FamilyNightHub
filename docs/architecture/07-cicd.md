# 07 — CI/CD

`ci.yml` exists with the `static`, `unit`, `integration`, `contract`, `bundle-secrets` and `e2e`
jobs (status column below), and `deploy.yml` is built (below). Multi-phone voting, host/TV and the photo drop in `e2e` are built; the SSE part
is still intended, not built. It combines OrderUp's
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
| `unit` | pytest `tests/unit` (+ Hypothesis tally properties), vitest (API client CSRF + error envelope, night-code input, ballot reducer; the photo pipeline's **GPS strip**: `frontend/e2e/fixtures/gps.jpg`, GPS-tagged, goes through `processPhoto` with a real JPEG encoder (`@napi-rs/canvas`) and exifr must find no GPS IFD, no EXIF and no APP1 `Exif` segment in either output; the upload queue's parallelism, retry/backoff and resume with fake timers; the IndexedDB job store; upload error sorting; album URL reuse inside the 10-minute TTL) | `backend/tests/unit`, `frontend/src/**/*.test.ts` | Built |
| `integration` | Whole pytest suite against Postgres + Redis service containers as `fnh_app`, after the role bootstrap. **Includes the isolation suite** (two seeded households, every table) and `test_rls_coverage`. Coverage gates run here | `backend/tests/integration` | Built. SeaweedFS service joins with the photo endpoints; endpoint-level isolation joins with the endpoints |
| `contract` | `alembic upgrade` → `downgrade base` → `upgrade` round trip, `alembic check` (models match migrations), `openapi.json` + `api.gen.ts` drift | ci.yml | Built |
| `e2e` | Postgres + Redis + MailHog service containers, role bootstrap + migrations, `next build`, then Playwright starts uvicorn and `next start`. Phone viewports (Pixel 7, and iPhone 13 on Chromium) with axe (WCAG 2.1 AA): join with the night code → pick an avatar, wrong code, lookalike characters, cookie redirects, magic-link request → emailed link → `/host` → sign out, bad and replayed tokens. Voting (`voting.spec.ts`): two phone contexts each vote for their own people (one phone shared by two people, with "Pass to next person"), the host closes through the API with `X-FNH-Test-Seed`, and both phones show the same winner; `/history` shows it with turnout; a phone can't vote for someone bound to another phone (pending claim, forced API call, and a stale ballot showing the server's message); a draft night says "Almost ready". Host + TV (`host-tv.spec.ts`): a TV context (1280×720) where the host starts a night and pairs it as the TV (code handed off in-tab), the host's phone builds a shortlist (forced TMDB 503 → typed titles; add, reorder, remove, reload) and opens voting, a phone joins and votes, a proxy vote, close with `X-FNH-Test-Seed`, TV turnout tiles light and the reveal lands on the stored winner; a paired TV asking for the code; `/tv` unpaired. Photos (`photos.spec.ts`, against a real S3 bucket: SeaweedFS 3.97 started as a step with `infra/seaweedfs/s3.json`, and `frontend/e2e/setup_bucket.py` creating the bucket plus its CORS rule for the web origin): a phone adds the GPS-tagged JPEG **and HEIC** fixtures (Chromium can't decode HEIC, so this exercises the `heic-to` worker fallback); the test fetches what landed in the bucket through the presigned URLs and asserts JPEG, no GPS, no EXIF; a second phone sees both on `/albums/[session]`, opens the viewer (uploader's name) and reacts, and the first phone sees the count; the first PUT to the bucket is dropped once and the queue's retry still lands the photo; and an **unauthenticated context gets 0 photo URLs** (every API answer it receives is read through a route and none contains a presigned signature, `GET …/photos` is 401, no `<img>` on the page). Each test seeds its own household (`frontend/e2e/seed_night.py`; `--movies N --open-voting` gives a night in voting, `--tonight` a night whose album is open, plus a signed host session cookie). Later: SSE, tmdb-fake | `frontend/e2e/` | Built (join + sign-in + phone voting + host/TV + photo drop); SSE later |
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
is accepted only when `ENVIRONMENT=test`; TMDB is always `tmdb-fake` (the CI `e2e` job doesn't run it
yet, so `host-tv.spec.ts` forces the search's 503 with `page.route` and uses typed titles). Host
and TV screens poll every 5s until SSE lands, so their assertions wait up to 15s.

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
2. **deploy-staging** (GitHub environment `staging`): pull both images **by digest**, then
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

**Inert until provisioned.** Each deploy job reads `FLY_API_TOKEN` from its environment. If it is
empty, the job emits a notice and skips its steps instead of failing `main`, and production then
skips too. **Give `production` its required reviewer before adding its token.** GitHub creates a
referenced environment without protection rules.

## Secrets map

| Secret | Where stored | Consumed by |
|---|---|---|
| `FLY_API_TOKEN` (staging, prod) | GitHub environments `staging`, `production` | deploy.yml |
| `GHCR` push | `GITHUB_TOKEN` | deploy.yml |
| App secrets | `fly secrets` (see [`02-environments.md`](02-environments.md)) | Fly apps |
| CI test secrets | none needed (local services, tmdb-fake) | — |

## What CI does NOT enforce

Worth knowing so you don't assume green means safe:
- Real iOS Safari HEIC behaviour. WebKit in Playwright is not iOS, so there is a manual iPhone checklist before each release that touches photos: [`runbooks/photo-drop-iphone-checklist.md`](../runbooks/photo-drop-iphone-checklist.md).
- The deployed (Tigris) buckets' CORS rule for the web origin. CI sets it only on its own SeaweedFS.
- Live TMDB terms and parameter behaviour, because CI uses the fake. Re-verify against the live docs before building the generator.
- Load, backup restore (rehearsed manually), and keeping the docs in sync with the code.
