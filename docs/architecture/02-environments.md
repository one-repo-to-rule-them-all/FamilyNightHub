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
| Object storage | SeaweedFS container (S3 API) | Tigris bucket `fnh-photos-staging` | Tigris `fnh-photos` + `fnh-photos-backup` |
| TMDB | fake server (`tmdb-fake` service) | real API key | real API key |
| Email | MailHog | provider sandbox | provider |
| Secrets source | `.env` (from `.env.example`) | `fly secrets` | `fly secrets` |
| Observability | logs | Sentry (staging env) | Sentry + Fly metrics + uptime check on `/api/health` |

## Per-environment detail

**dev.** `docker compose up -d`, then `docker compose run --rm api alembic upgrade head` and the seed
(one household, six people with emoji avatars, twenty owned movies, a past night with photos). SeaweedFS
stands in for Tigris because both are S3-compatible. Set `STORAGE_ENDPOINT` accordingly.

**staging.** It gets the same deploy as prod on every merge to `main` and is used to test on a
real iPhone. Its data is synthetic. Never copy production photos into it.

**production.** Promoted by manual approval. The API runs on `shared-cpu-1x`/512 MB. Movie night is
bursty, so `min_machines_running = 1` on `fnh-api` and `fnh-web` keeps cold starts off the reveal
moment. The worker can auto-stop between cron windows.

**Cost (estimate, verify at setup):** two or three small machines plus small Fly Postgres plus storage
under 5 GB comes to roughly $10–30/mo. Not $0 by design (ADR-0001).

## Secrets map

| Secret | Where stored | Consumed by |
|---|---|---|
| `DATABASE_URL` (app role `fnh_app`) | fly secrets | api, worker |
| `MIGRATION_DATABASE_URL` (owner role) | fly secrets (release command only) | api release_command |
| `REDIS_URL` | fly secrets | api, worker |
| `STORAGE_*` (photos bucket, read/write) | fly secrets | api, worker |
| `BACKUP_STORAGE_*` (backup bucket, write-only) | fly secrets | **worker only** |
| `TMDB_READ_TOKEN` (with plain-env `TMDB_BASE_URL`; unset token = search off, typed titles only) | fly secrets | api only (never `NEXT_PUBLIC_*`) |
| `SESSION_SECRET`, `DEVICE_TOKEN_PEPPER` | fly secrets | api |
| `EMAIL_API_KEY` (SMTP password; with `SMTP_HOST`/`SMTP_PORT`/`SMTP_USERNAME`/`SMTP_STARTTLS`, `EMAIL_MODE=smtp`, `EMAIL_FROM`) | fly secrets (+ plain env for the non-secret ones) | api, worker |
| `SENTRY_DSN` | fly secrets | all |
| `FLY_API_TOKEN` | GitHub environment secret | deploy workflow |

## Migrations & health

- **Roles:** provisioning runs `backend/db/init/00-init-app-role.sql` once per database as a role
  with `CREATEROLE`. It creates `fnh_app` (runtime) and `fnh_resolver` (ADR-0009). Migration
  `0001` refuses to run if either is missing. Compose runs the script automatically.
- **First admin:** after the first deploy, `fly ssh console -a fnh-api -C "python -m app.cli
  bootstrap --household ... --slug ... --email ... --name ..."` creates the household, its
  settings and the admin account, and prints the fridge-QR URL. Locally: `docker compose -p fnh
  exec api python -m app.cli bootstrap ...`; magic links land in MailHog (`:58025`).
- **When migrations run:** Fly `release_command = "alembic upgrade head"` on `fnh-api`, using the owner role, before new machines start. Migrations must be backward-compatible with the previous release (expand/contract).
- **Health checks:** `GET /api/health` (DB `select 1` with GUC set for a sentinel household, plus a Redis ping) gates the deploy, and the uptime monitor pings it every 5 minutes.
- **Postgres backups:** Fly's daily volume snapshots plus a weekly `pg_dump` from the worker into the backup bucket. Restore runbook: `docs/runbooks/restore.md` (Phase 1 deliverable).

## Known gaps

- No custom domain yet, so the QR encodes the fly.dev URL. Reprint the QR when a domain is added; it
  should point at a redirecting `/j/{slug}`, which keeps the printed code stable.
- No load testing (the expected load is ten phones).
- Real-iPhone HEIC testing is manual.
