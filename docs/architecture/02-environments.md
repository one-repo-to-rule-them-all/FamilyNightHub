# 02 — Environments

Three environments, mirroring OrderUp: local Docker Compose, then staging and production on Fly.io.
See [ADR-0001](decisions/ADR-0001-fly-fastapi-postgres-hosting.md).

## At a glance

| | dev (local) | staging | production |
|---|---|---|---|
| Host | Docker Compose | Fly.io (`fnh-*-staging`) | Fly.io (`fnh-*`) |
| URL(s) | http://localhost:3000 | `fnh-web-staging.fly.dev` | `fnh-web.fly.dev` (+ custom domain later) |
| Infra layer | `docker-compose.yml` + override | `deploy/staging/*.fly.toml` | `deploy/prod/*.fly.toml` |
| Image source | local build | GHCR image built in CI | same image digest promoted from staging |
| Datastore | `postgres:16` container | Fly Postgres (small) | Fly Postgres (small, daily snapshots) |
| Cache/queue | `redis:7` container | Upstash (free tier) | Upstash |
| Object storage | SeaweedFS container (S3 API) | Tigris bucket `fnh-rbj-photos-staging` | Tigris `fnh-rbj-photos` + `fnh-rbj-photos-backup` |
| TMDB | fake server (`tmdb-fake` service) | real API key | real API key |
| Email | MailHog | provider sandbox | provider |
| Secrets source | `.env` (from `.env.example`) | `fly secrets` | `fly secrets` |
| Observability | logs | Sentry (staging env) | Sentry + Fly metrics + uptime check on `/api/health` |

## Per-environment detail

**dev.** `docker compose up -d`, then `docker compose run --rm api alembic upgrade head` and the seed
(one household, six people with emoji avatars, twenty owned movies, a past night with photos). SeaweedFS
stands in for Tigris because both are S3-compatible. Set `STORAGE_ENDPOINT` accordingly; when the
API reaches the bucket at a different address than phones do (the compose `api` service uses
`http://s3:8333`), set `STORAGE_PUBLIC_ENDPOINT` to the phone-facing one (`http://localhost:58333`):
SigV4 signs the host, so presigned URLs are minted against it.

**staging.** It gets the same deploy as prod on every merge to `main` and is used to test on a
real iPhone. Its data is synthetic. Never copy production photos into it.

**production.** Promoted by manual approval. The API runs on `shared-cpu-1x`/512 MB. Movie night is
bursty, so `min_machines_running = 1` on `fnh-api` and `fnh-web` keeps cold starts off the reveal
moment. The worker runs **continuously** (one machine). It was planned to auto-stop between cron
windows, but Fly's auto-start is triggered by fly-proxy traffic, and nothing ever sends the worker
a request: a stopped worker would never wake, and its crons would silently stop.

**Cost:** ADR-0001 estimated roughly $10–30/mo. Checked against 2026-10-15 prices in
[ADR-0013](decisions/ADR-0013-hosting-cost-correction.md) (Accepted): this topology on Managed
Postgres with both environments always on is about **$125/mo**. The accepted plan is
self-operated Postgres, Upstash Fixed for production, and staging scaled to zero when idle,
which comes to about **$30/mo**. Not $0 by design (ADR-0001). Decided 2026-10-16.

**First deploy:** one ordered checklist, from an empty Fly org to the fridge QR, is
[`runbooks/first-deploy.md`](../runbooks/first-deploy.md).

## Fly topology and the `/api` proxy

| App | Config | Public? | Notes |
|---|---|---|---|
| `fnh-web(-staging)` | `deploy/*/web.fly.toml` | yes, `*.fly.dev` | Next standalone, `frontend/Dockerfile`. Proxies `/api/*` to the API |
| `fnh-api(-staging)` | `deploy/*/api.fly.toml` | **no**, Flycast only | `release_command = "alembic upgrade head"`, HTTP check on `/api/health` |
| `fnh-worker(-staging)` | `deploy/*/worker.fly.toml` | no services | Same image as the API, `python -m app.workers.main`, check on `:8081/health` |

All three apps run `shared-cpu-1x`/512 MB in `dfw`.

- **Web → API goes over Flycast** (`API_INTERNAL_URL=http://fnh-api(-staging).flycast`), not
  `.internal`. `.internal` dials the machine directly over IPv6, while uvicorn binds IPv4
  `0.0.0.0` (verified: the IPv6 dial is refused). Flycast also routes through fly-proxy, so the
  API's health check and load balancing apply. The API gets no public IP (`--no-public-ips`).
- **One web image for both environments.** Next freezes `rewrites()` destinations at build time.
  The image is built with a placeholder origin, and `frontend/docker-entrypoint.sh` swaps in the
  runtime `API_INTERNAL_URL` at boot. Without it, the container refuses to start.
- **SSE through the chain (ADR-0004).** fly-proxy streams responses. The Next proxy in `fnh-web`
  gzips any compressible response for clients that send `Accept-Encoding: gzip` (every browser),
  which **buffers an SSE stream until it ends**. That was verified locally against the built
  image. The SSE route must send `Cache-Control: no-cache, no-transform`, which makes Next skip
  compression, plus a heartbeat comment well inside fly-proxy's idle timeout.
  Both apps count concurrency by connections, not requests.
- **Photos bucket CORS (ADR-0005).** Phones PUT to the bucket and load photos from it through
  presigned URLs, cross-origin from `fnh-web`, so each bucket allows its environment's web origin:
  `PUT` and `GET`, header `content-type`, max age 600. The deploy workflow sets it from
  `deploy/<env>/api.fly.toml`'s `CORS_ALLOWED_ORIGINS` (one source for the API and the bucket)
  with a separate bucket-admin key held only in the GitHub environment. The API's `STORAGE_*` key
  stays object read/write; a compromised API can't widen the rule. Locally and in CI,
  `frontend/e2e/setup_bucket.py` does the same for SeaweedFS.

## Secrets map

| Secret | Where stored | Consumed by |
|---|---|---|
| `DATABASE_URL` (app role `fnh_app`) | fly secrets | api, worker |
| `MIGRATION_DATABASE_URL` (owner role) | fly secrets (release command only) | api release_command |
| `REDIS_URL` | fly secrets | api, worker |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` (photos bucket, read/write; unset endpoint or keys = photo routes answer 503) | fly secrets; the non-secret `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION` sit in `api.fly.toml`/`worker.fly.toml` `[env]` (unset, the bucket would default to production's `fnh-rbj-photos`); `STORAGE_PUBLIC_ENDPOINT` is local-only | api, worker |
| `BACKUP_STORAGE_*` (backup bucket, write-only) | fly secrets | **worker only** |
| `TMDB_READ_TOKEN` (with plain-env `TMDB_BASE_URL`; unset token = search off, typed titles only) | fly secrets | api only (never `NEXT_PUBLIC_*`) |
| `SESSION_SECRET`, `DEVICE_TOKEN_PEPPER`, `PLATFORM_SESSION_SECRET` (ADR-0016, signs `fnh_platform`) | fly secrets | api; the **worker** also needs its **own random** values (unused, but Settings refuses to load in staging/production without non-placeholder ones, so the worker would crash-loop) |
| `EMAIL_API_KEY` (SMTP password; STARTTLS on 587, no implicit TLS) with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `EMAIL_FROM` | fly secrets (provider-specific, set at provisioning); `EMAIL_MODE=smtp` and `SMTP_STARTTLS=true` in `api.fly.toml` | api; the worker only for `remind_disabled_households` (ADR-0017 §4), which logs instead of sending until the worker has these too |
| `SENTRY_DSN` | fly secrets | all |
| `API_INTERNAL_URL` (not secret) | `web.fly.toml` `[env]` | web (server only, read at boot) |
| `FLY_API_TOKEN` | GitHub environment secret (`staging`, `production`) | deploy workflow |
| `BUCKET_ADMIN_ACCESS_KEY_ID`, `BUCKET_ADMIN_SECRET_ACCESS_KEY` (photos bucket config, for its CORS rule; with environment variable `PHOTOS_BUCKET`) | GitHub environment secret (`staging`, `production`), **never** fly secrets | deploy workflow only (`deploy/bucket-cors.sh`) |

## Migrations & health

- **Roles:** provisioning runs `backend/db/init/00-init-app-role.sql` once per database as a role
  with `CREATEROLE` (on Fly, the `postgres` superuser; the owner `fnh` is CREATEROLE but **not**
  superuser, and the script's `GRANT CREATE ON SCHEMA public TO fnh_resolver` is what lets a
  non-superuser owner run migration 0001; [first-deploy step 3](../runbooks/first-deploy.md#3-postgres-and-the-role-bootstrap)). It creates `fnh_app` (runtime) and `fnh_resolver` (ADR-0009). Migration
  `0001` refuses to run if either is missing. Compose runs the script automatically. On Fly, follow
  [runbook §1.2](../runbooks/restore.md#12-postgres-legacy-fly-postgres): never `fly postgres
  attach`, and replace the script's dev password for `fnh_app` straight away.
- **First admin:** after the first deploy, `fly ssh console -a fnh-api -C "python -m app.cli
  bootstrap --household ... --slug ... --email ... --name ..."` creates the household, its
  settings and the admin account, and prints the fridge-QR URL. Locally: `docker compose -p fnh
  exec api python -m app.cli bootstrap ...`; magic links land in MailHog (`:58025`).
- **When migrations run:** Fly `release_command = "alembic upgrade head"` on `fnh-api`, using the owner role, before new machines start. Migrations must be backward-compatible with the previous release (expand/contract).
- **Health checks:** `GET /api/health` (DB `select 1` with GUC set for a sentinel household, plus a Redis ping) gates the deploy, and the uptime monitor pings it every 5 minutes.
- **Postgres backups:** Fly's daily volume snapshots. The weekly `pg_dump` from the worker is not
  built: it waits on its own ADR (06). Provisioning, restore and rollback:
  [`docs/runbooks/restore.md`](../runbooks/restore.md).

## Known gaps

- No custom domain yet, so the QR encodes the fly.dev URL. Reprint the QR when a domain is added; it
  should point at a redirecting `/j/{slug}`, which keeps the printed code stable.
- No load testing (the expected load is ten phones).
- Real-iPhone HEIC testing is manual.
