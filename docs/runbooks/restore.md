# Runbook: provisioning, restore and rollback

**First time?** Follow [`first-deploy.md`](first-deploy.md), the ordered checklist. It links back
into the sections here and adds the steps around them: email DNS, GitHub environments, the
first admin and the fridge QR.

Phase 1 deliverable named in [`02-environments.md`](../architecture/02-environments.md). Three
parts: **provision** an environment from nothing (do this once per environment), **restore**
data after a loss, and **roll back** a bad deploy. Commands use staging names; for production
drop the `-staging` suffix and use `deploy/prod/`.

> **Restore is rehearsed manually** (07 "What CI does NOT enforce"). Rehearse on staging after
> provisioning and at least once a quarter, and note the date at the bottom of this file.

---

## 0. Decide before provisioning

1. **Postgres flavour and the cost estimate.** ADR-0001 estimates $10–30/mo for the whole
   environment. That figure predates Fly's **Managed Postgres** (MPG). Check current pricing:
   - *Fly Managed Postgres*: Fly runs it (backups, failover, upgrades). Its smallest plan may by
     itself exceed the ADR's range.
   - *Legacy "Fly Postgres"* (`fly postgres create`): an ordinary Fly app you operate yourself,
     about the price of one small machine plus a volume, with daily volume snapshots.

   This runbook is written for the **legacy** flavour because 02 assumes "Fly's daily volume
   snapshots". If MPG is chosen, sections 1.2 and 2.1 change to MPG's own connection and
   restore commands, and ADR-0001's cost line needs a superseding ADR. Prices checked on
   2026-10-15 are in [ADR-0013](../architecture/decisions/ADR-0013-hosting-cost-correction.md)
   (Accepted 2026-10-16), which chose this legacy flavour: MPG is $38/mo per environment and
   has no superuser or CREATEROLE to create our roles.
2. **Bucket names.** Tigris bucket names are global. If `fnh-photos`, `fnh-photos-staging` or
   `fnh-photos-backup` are taken, pick new names and update 02 and 05.
3. **Deploy-token scope.** `FLY_API_TOKEN` must deploy three apps. A per-app deploy token
   (`fly tokens create deploy -a <app>`) covers one app, so the simple option is an org token
   with an expiry. If staging and production share one Fly org, the staging token can also
   deploy production; separate orgs avoid that, at the cost of a little admin.

## 1. Provision an environment

Run from the repo root with `flyctl` signed in. Region `dfw` everywhere (Central time, 06).

### 1.1 Apps

```bash
fly apps create fnh-api-staging
fly apps create fnh-worker-staging
fly apps create fnh-web-staging
# The API is private: a Flycast address only, never a public one (deploy.yml passes
# --no-public-ips). fnh-web reaches it at http://fnh-api-staging.flycast.
fly ips allocate-v6 --private -a fnh-api-staging
```

### 1.2 Postgres (legacy Fly Postgres)

```bash
fly postgres create --name fnh-db-staging --region dfw \
  --vm-size shared-cpu-1x --volume-size 1 --initial-cluster-size 1
```

**Do not run `fly postgres attach`.** It creates its own user and sets `DATABASE_URL` to a
role that owns the tables, and table owners skip RLS unless forced; ADR-0003 needs the app on
the ordinary `fnh_app` role. Instead, through `fly proxy 15432:5432 -a fnh-db-staging` and as
the `postgres` superuser:

```sql
CREATE ROLE fnh LOGIN CREATEROLE PASSWORD '<owner password>';
CREATE DATABASE fnh OWNER fnh;
```

Then, connected to database `fnh` as `postgres`, run the role bootstrap **once**:

```bash
psql "postgresql://postgres:<pw>@localhost:15432/fnh" -v ON_ERROR_STOP=1 \
  -f backend/db/init/00-init-app-role.sql
```

It creates `fnh_app` with the **dev password `fnh_app`**. Replace it immediately:

```sql
ALTER ROLE fnh_app PASSWORD '<runtime password>';
```

The URLs (private network, no TLS needed inside 6PN):

```text
DATABASE_URL=postgresql+asyncpg://fnh_app:<runtime pw>@fnh-db-staging.flycast:5432/fnh
MIGRATION_DATABASE_URL=postgresql+psycopg2://fnh:<owner pw>@fnh-db-staging.flycast:5432/fnh
```

Production: confirm daily snapshots are on and retained 7 days
(`fly volumes list -a fnh-db`, then `fly volumes snapshots list <vol-id>`).

### 1.3 Redis (Upstash)

`fly redis create` (Fly-provisioned Upstash) or upstash.com, region near `dfw`. Use **DB 0**
(Upstash has no other): ARQ uses the `arq:` prefix and SSE the `session:*` channels on the same
instance. `REDIS_URL` exactly as printed: `redis://default:<pw>@fly-<name>.upstash.io:6379`
over Fly's private network for `fly redis create`, `rediss://…` (TLS) from upstash.com. Plan:
ADR-0013 (an idle ARQ worker polls about 5M commands/month).

### 1.4 Tigris buckets

- Staging: `fnh-photos-staging` (private). No backup bucket.
- Production: `fnh-photos` (private) and `fnh-photos-backup` (private), each with **its own
  access key**. The backup key goes on `fnh-worker` only. If the API is ever compromised, its
  keys cannot touch the backups (06 "Gotchas").

`fly storage create` sets `AWS_*`/`BUCKET_NAME` secrets on whichever app it targets. The app
reads the `STORAGE_*` / `BACKUP_STORAGE_*` names in 02's secrets map, so remove the auto-set
ones (`fly secrets unset`) and set only the keys under the 02 names (`STORAGE_ACCESS_KEY_ID`,
`STORAGE_SECRET_ACCESS_KEY`). `STORAGE_ENDPOINT`, `STORAGE_BUCKET` and `STORAGE_REGION` are in the
api and worker fly.toml `[env]`. `BACKUP_STORAGE_*` stays inert until `backup_new_photos` lands.

**CORS for phone uploads.** Create one more key per photos bucket that can change its config
(Tigris dashboard, scoped to that bucket only) and put it **only** in the GitHub environment,
never on a Fly app: secrets `BUCKET_ADMIN_ACCESS_KEY_ID` / `BUCKET_ADMIN_SECRET_ACCESS_KEY`, plus
variable `PHOTOS_BUCKET` (`fnh-photos-staging` on `staging`, `fnh-photos` on `production`). The
next Deploy run sets the rule (07-cicd "Photos bucket CORS"); re-run it by hand to apply now.

### 1.5 Secrets (02 "Secrets map")

```bash
fly secrets set -a fnh-api-staging --stage \
  DATABASE_URL=... MIGRATION_DATABASE_URL=... REDIS_URL=... \
  SESSION_SECRET="$(openssl rand -base64 48)" DEVICE_TOKEN_PEPPER="$(openssl rand -base64 48)" \
  SMTP_HOST=... SMTP_PORT=587 SMTP_USERNAME=... EMAIL_API_KEY=... EMAIL_FROM="Family Night <...>" \
  SENTRY_DSN=... TMDB_READ_TOKEN=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=...

# The worker's SESSION_SECRET / DEVICE_TOKEN_PEPPER are its OWN random values: unused, but
# Settings refuses to load in staging/production without them (the worker crash-loops).
# No email secrets: the worker sends none.
fly secrets set -a fnh-worker-staging --stage \
  DATABASE_URL=... REDIS_URL=... SENTRY_DSN=... \
  SESSION_SECRET="$(openssl rand -hex 32)" DEVICE_TOKEN_PEPPER="$(openssl rand -hex 32)" \
  STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=...
# production only: BACKUP_STORAGE_...=... on fnh-worker, and nowhere else
```

`fnh-web` needs no secrets (the frontend reads no server env besides `API_INTERNAL_URL`).
Exact, ordered commands: [`first-deploy.md`](first-deploy.md) step 8.

- `--stage` defers the restart to the first deploy.
- The API refuses to boot in staging/production with the `dev-insecure-*` placeholders.
- `SESSION_SECRET` and `DEVICE_TOKEN_PEPPER` must differ per environment. Rotating the pepper
  logs out every device.
- Non-secret settings (`ENVIRONMENT`, `FRONTEND_BASE_URL`, `CORS_ALLOWED_ORIGINS`,
  `EMAIL_MODE`, `SMTP_STARTTLS`, `API_INTERNAL_URL`) live in the fly.toml `[env]` blocks.

### 1.6 GitHub

1. Create environments `staging` and `production`.
2. **Give `production` a required reviewer first** (Settings → Environments → production).
   GitHub creates referenced environments without protection, so a token added to an
   unprotected `production` would deploy with no approval.
3. Add `FLY_API_TOKEN` to each environment. Until then `deploy.yml` builds images and skips
   deploys with a notice.

### 1.7 First deploy and first admin

1. Re-run **Deploy** from the Actions tab (`workflow_dispatch`), or merge to `main`. The API's
   `release_command` runs `alembic upgrade head`. Migration 0001 refuses to run without the
   1.2 roles.
2. After the worker's first deploy: `fly scale count 1 -a fnh-worker-staging` (exactly one
   worker; the crons are `unique` but nothing needs two).
3. Check: `fly ips list -a fnh-api-staging` shows only a private address;
   `curl https://fnh-web-staging.fly.dev/api/health` returns `"status":"ok"`;
   `fly checks list -a fnh-worker-staging` is passing.
4. First admin:

   ```bash
   fly ssh console -a fnh-api-staging -C "python -m app.cli bootstrap \
     --household 'The Family' --slug <join-slug> --email <admin email> --name <name>"
   ```

   It prints the fridge-QR URL. Magic links go out through the SMTP provider.
5. Production: point the uptime monitor at `https://fnh-web.fly.dev/api/health` every 5 minutes.

## 2. Restore

### 2.1 Postgres from a Fly snapshot (legacy Fly Postgres)

A snapshot restores into a **new** cluster. The broken one stays put until you've verified.

```bash
fly volumes list -a fnh-db                       # find the data volume
fly volumes snapshots list <volume-id>           # pick a snapshot (daily, 7 kept)
fly postgres create --name fnh-db-restore --region dfw \
  --snapshot-id <snapshot-id> --vm-size shared-cpu-1x --volume-size 1
```

1. Verify through `fly proxy 15433:5432 -a fnh-db-restore` as `fnh`: `alembic_version`
   matches the deployed code, and row counts in `sessions`, `photos` and `audit_events` look
   right. Roles and grants come back with the snapshot; the passwords are those at snapshot
   time.
2. Stop writes during the cut-over: `fly scale count 0 -a fnh-worker` and accept that the API
   is briefly down.
3. Repoint: `fly secrets set -a fnh-api DATABASE_URL=...fnh-db-restore.flycast... MIGRATION_DATABASE_URL=...`,
   and `DATABASE_URL` on `fnh-worker`.
4. `fly scale count 1 -a fnh-worker`, then check `/api/health` and the admin home page.
5. Destroy the old cluster after a week of normal operation, not before.

Data written after the snapshot is lost (RPO up to 24h). The weekly `pg_dump` that would
narrow this is **not built**: it needs a read-only dump role that can read FORCE-RLS tables,
and its own ADR (06).

### 2.2 Photos from `fnh-photos-backup`

**Prerequisite:** `backup_new_photos` exists. Until the photo pipeline ships it, there is no
backup to restore from.

The backup bucket mirrors the photos bucket key for key (06). Restore copies back the objects
of photos the database still has:

1. Use a **separate, read-capable** key for the backup bucket, kept offline by the owner. The
   worker's backup key is meant to be write-only and may not be able to read.
2. List what should exist, as `fnh` through `fly proxy`:

   ```sql
   COPY (SELECT object_key FROM photos WHERE status <> 'pending'
         UNION ALL SELECT thumb_key FROM photos WHERE status <> 'pending')
   TO STDOUT;
   ```

   Save it as `keys.txt`. Pending rows are excluded: the sweep deletes them anyway.
3. Copy each key from the backup bucket to the photos bucket. Tigris endpoint:
   `https://fly.storage.tigris.dev`.

   ```bash
   while read -r key; do
     aws s3 cp "s3://fnh-photos-backup/$key" "s3://fnh-photos/$key" \
       --endpoint-url https://fly.storage.tigris.dev --profile fnh-restore
   done < keys.txt
   ```

   The profile needs read on the backup bucket and write on the photos bucket. For a whole-
   bucket loss, `aws s3 sync s3://fnh-photos-backup s3://fnh-photos` is simpler. It may also
   bring back a photo deleted within the last day whose backup purge hadn't run yet, so
   re-run step 2's list and delete any object without a row.
4. Spot-check a few album pages. Presigned GETs are minted per request, so nothing is cached.

Never copy production photos into staging (02).

## 3. Roll back a deploy

Migrations are expand/contract (07), so rolling back code needs no down-migration. Redeploy
the previous image by its `sha-<commit>` tag from GHCR. The `docker pull` plus `--local-only`
mirrors `deploy.yml`: Fly never needs GHCR credentials.

**Skip the release command when rolling back.** If the bad release added a migration, the
database is at a revision the older image has never heard of, and its `alembic upgrade head`
fails with "Can't locate revision", blocking the rollback. Deploy the API from a copy of its
config without `release_command`. The schema stays where it is, which expand/contract allows.

```bash
PREV=<previous good commit sha>
for image in backend web; do
  docker pull "ghcr.io/one-repo-to-rule-them-all/fnh-$image:sha-$PREV"
done
sed '/release_command/d' deploy/prod/api.fly.toml > deploy/prod/api.rollback.fly.toml
flyctl deploy --config deploy/prod/api.rollback.fly.toml \
  --image "ghcr.io/one-repo-to-rule-them-all/fnh-backend:sha-$PREV" --local-only --no-public-ips
rm deploy/prod/api.rollback.fly.toml
flyctl deploy --config deploy/prod/worker.fly.toml \
  --image "ghcr.io/one-repo-to-rule-them-all/fnh-backend:sha-$PREV" --local-only
flyctl deploy --config deploy/prod/web.fly.toml \
  --image "ghcr.io/one-repo-to-rule-them-all/fnh-web:sha-$PREV" --local-only
```

The next normal deploy from `main` restores the regular config and its release command.

---

**Rehearsals:** none yet.
