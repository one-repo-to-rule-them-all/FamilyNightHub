# Runbook: first deploy (staging, then production)

This is the single ordered checklist from an empty Fly org to a family night. Each step depends
only on the steps above it, so it never deadlocks. Background and the restore and rollback
procedures stay in [`restore.md`](restore.md). Where a step is identical, this page links
there instead of repeating it. Names come from 02's
[secrets map](../architecture/02-environments.md#secrets-map).

**Markers.** 🌐 = the owner does it in a browser (accounts, dashboards, DNS, approvals).
⌨️ = CLI from the repo root. Every value in `<angle brackets>` is yours to fill in. Every
secret is generated or pasted at the prompt, never committed.

**Conventions.** The commands use staging names. For production, drop `-staging` and use
`deploy/prod/`. Generate every password with `openssl rand -hex 24`: hex needs no URL
escaping inside `postgresql://` and `redis://` URLs. Keep the values in a password manager as
you go. Steps 8 and 11 need them again.

**What was already verified locally** (PR "first-deploy readiness", 2026-10-15): the deployed
images were booted together with `ENVIRONMENT=staging`, real secrets, a **non-superuser**
owner role, HTTPS in front of the web app, and an S3 bucket. The role bootstrap, `alembic
upgrade head`, health, the CLI bootstrap, a magic link, join, vote, SSE through the `/api`
rewrite for more than 45 s, and the photo presign/PUT/complete/GET path with
`deploy/bucket-cors.sh`'s rule all passed. **Not** verified, because they need real accounts:
Tigris itself, Upstash TLS and auth, real SMTP delivery, Flycast, fly-proxy, and Fly's
release machine.

---

## 0. Decide and pre-flight (once)

- [x] **Postgres flavour and cost: decided** ([ADR-0013](../architecture/decisions/ADR-0013-hosting-cost-correction.md),
      Accepted 2026-10-16): self-operated Postgres (legacy `fly postgres create`, or the
      `postgres:16` app fallback), not Managed Postgres. Upstash Fixed for production,
      pay-as-you-go for staging. Staging scaled to zero when idle (step at the end).
      Expected bill: about $30/mo.
- [ ] 🌐 **A domain for email.** The production magic links need a sending domain you control
      (step 6). Without one, staging can still send to your own address only.
- [ ] ⌨️ Tools: `flyctl` (`fly version` ≥ 0.3.211), `gh` (signed in, repo admin), `psql` 16,
      `aws` CLI v2, `openssl`, `jq`.
- [ ] ⌨️ **Main is green.** CI is disabled on this repo, and `deploy.yml` fires only when CI
      succeeds for a push to `main` (07-cicd). Re-enable it and run the full suite on `main`
      once before anything deploys:

      ```bash
      gh workflow enable ci.yml -R one-repo-to-rule-them-all/FamilyNightHub
      gh workflow run ci.yml --ref main -R one-repo-to-rule-them-all/FamilyNightHub
      gh run watch -R one-repo-to-rule-them-all/FamilyNightHub
      ```

      If you'd rather keep CI disabled, run the suites locally on a clean `main` (07-cicd
      "Running E2E locally") and record the commit SHA you tested. Deploy that SHA.

## 1. Fly account

- [ ] 🌐 Create the Fly org and add a payment method. New orgs get no free allowance.
- [ ] ⌨️ `fly auth login`. Then `fly orgs list` and note `<org>`.

> **Staging steps 2–9 are scripted:** `bash deploy/scripts/provision-staging.sh` (owner runs it
> in Git Bash from the repo root). It generates every password itself, asks for each
> provider-issued credential at a hidden prompt, pipes the Fly deploy token straight into
> GitHub, and is safe to re-run. The manual steps below stay the reference, and the
> procedure for production (step 14).

## 2. Apps

- [ ] ⌨️ Create the three apps and give the API a private Flycast address only
      ([restore.md §1.1](restore.md#11-apps)):

      ```bash
      fly apps create fnh-api-staging --org <org>
      fly apps create fnh-worker-staging --org <org>
      fly apps create fnh-web-staging --org <org>
      fly ips allocate-v6 --private -a fnh-api-staging
      ```

## 3. Postgres and the role bootstrap

The database is created empty here. Migrations run later, in the API's `release_command`
(step 10), and they **refuse to run** until this step has created the roles.

- [ ] ⌨️ Create the cluster ([restore.md §1.2](restore.md#12-postgres-legacy-fly-postgres)):

      ```bash
      fly postgres create --name fnh-db-staging --org <org> --region dfw \
        --vm-size shared-cpu-1x --volume-size 1 --initial-cluster-size 1
      ```

      Save the `postgres` superuser password it prints. If flyctl offers Managed Postgres,
      pick the unmanaged option. If unmanaged no longer exists for a new org, stop and use
      ADR-0013's fallback (`postgres:16` as a Fly app), which is the same SQL from here on.
      **Never `fly postgres attach`.**
- [ ] ⌨️ In a second terminal: `fly proxy 15432:5432 -a fnh-db-staging`.
- [ ] ⌨️ As `postgres`, create the owner role and the database, run the bootstrap **once**, and
      replace the dev password it gives `fnh_app`:

      ```bash
      OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)   # save both
      SUPER="postgresql://postgres:<superuser pw>@localhost:15432"
      psql "$SUPER/postgres" -v ON_ERROR_STOP=1 \
        -c "CREATE ROLE fnh LOGIN CREATEROLE PASSWORD '$OWNER_PW';" \
        -c "CREATE DATABASE fnh OWNER fnh;"
      psql "$SUPER/fnh" -v ON_ERROR_STOP=1 -f backend/db/init/00-init-app-role.sql
      psql "$SUPER/fnh" -v ON_ERROR_STOP=1 -c "ALTER ROLE fnh_app PASSWORD '$APP_PW';"
      psql "$SUPER/fnh" -c '\du'   # fnh: Create role; fnh_app: (none); fnh_resolver: Cannot login
      ```

      `fnh` must **not** be a superuser: table owners and superusers skip RLS (ADR-0003). The
      script grants `fnh_resolver` CREATE on `public`, which the migration needs to hand it
      the resolver functions. Without that grant, a non-superuser `fnh` makes
      `alembic upgrade head` fail with *permission denied for schema public*.
- [ ] ⌨️ Snapshots: `fly volumes list -a fnh-db-staging`, then set retention to 7 days
      (`fly volumes update <vol-id> --snapshot-retention 7`; check `--help` for the flag on
      your flyctl).
- [ ] Record the two URLs for step 8 (private network, no TLS inside 6PN):

      ```text
      DATABASE_URL=postgresql+asyncpg://fnh_app:<APP_PW>@fnh-db-staging.flycast:5432/fnh
      MIGRATION_DATABASE_URL=postgresql+psycopg2://fnh:<OWNER_PW>@fnh-db-staging.flycast:5432/fnh
      ```

## 4. Redis (Upstash)

- [ ] ⌨️ `fly redis create --name fnh-redis-staging --org <org> --region dfw --no-replicas`.
      Plan: **pay-as-you-go** for staging, **Fixed 250 MB** for production (ADR-0013: an idle
      ARQ worker polls about 5M commands/month). Record the URL it prints as `REDIS_URL`,
      exactly as printed (`redis://` on Fly's private network, or `rediss://` from
      upstash.com). Database 0 only; ARQ and SSE share it.

## 5. Tigris buckets and keys

Bucket names are global. If one is taken, choose another **and** change `STORAGE_BUCKET` in
`deploy/<env>/{api,worker}.fly.toml` and `PHOTOS_BUCKET` in step 9 to match.

- [ ] ⌨️ `fly storage create --name fnh-photos-staging --org <org>` (private by default; don't
      pass `-a`, so nothing is auto-set on an app). It prints an access key pair. That pair
      is the **API's read/write key**: `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`.
- [ ] 🌐 `fly storage dashboard fnh-photos-staging`. In the Tigris console:
  - confirm the printed key is limited to **this bucket** with Editor (read/write), not Admin;
  - create a second key, **Admin on this bucket only**. This is the **bucket-admin key** for
    the CORS rule. It goes into GitHub only (step 9), never onto a Fly app.
- [ ] Production only: also `fly storage create --name fnh-photos-backup --org <org>`. Then
      create a key limited to the backup bucket for the worker (`BACKUP_STORAGE_*`; inert
      until `backup_new_photos` lands), and an offline **restore key** (read the backup
      bucket, write the photos bucket) that you keep in your password manager
      ([restore.md §2.2](restore.md#22-photos-from-fnh-photos-backup)).
- [ ] The CORS rule is **not** set by hand: the Deploy workflow sets it and reads it back
      before every deploy (`deploy/bucket-cors.sh`, step 10).

## 6. Email provider (magic links)

The API sends magic links over SMTP with STARTTLS (`smtplib`, port 587). It does **not**
support implicit TLS on 465. Resend is the example; any SMTP provider works the same way.

- [ ] 🌐 Create the Resend account, then **Domains → Add domain** (e.g. `mail.<your domain>`).
- [ ] 🌐 At your DNS host, add exactly the records Resend shows, then click Verify. They are
      typically:
      - an MX record on `send.<domain>` pointing at Resend's feedback host;
      - a TXT record on `send.<domain>` with the SPF value (`v=spf1 include:… ~all`);
      - a TXT record on `resend._domainkey.<domain>` with the DKIM key;
      - optionally, a TXT record on `_dmarc.<domain>` with `v=DMARC1; p=none;`.
- [ ] 🌐 **API Keys → Create**, with *Sending access* limited to that domain. The key is
      `EMAIL_API_KEY`.
- [ ] Values for step 8: `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`,
      `SMTP_USERNAME=resend`, `EMAIL_FROM="Family Night <movie-night@<domain>>"`.
      `EMAIL_MODE=smtp` and `SMTP_STARTTLS=true` already sit in `api.fly.toml`.
      Before the domain verifies, staging can use `onboarding@resend.dev` as the sender,
      but then it delivers only to your own Resend account address.

## 7. Optional integrations

- [ ] 🌐 TMDB: a v4 **read access token** (themoviedb.org → Settings → API) becomes
      `TMDB_READ_TOKEN`. Without it, search answers 503 and hosts type titles.
- [ ] 🌐 Sentry: a project gives you `SENTRY_DSN`. Leave it unset to disable Sentry.

## 8. Fly secrets, per app

`--stage` stores the secrets without restarting anything (nothing is deployed yet). Non-secret
settings (`ENVIRONMENT`, `FRONTEND_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `EMAIL_MODE`,
`SMTP_STARTTLS`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION`, `API_INTERNAL_URL`,
`WORKER_HEALTH_PORT`) already sit in the fly.toml `[env]` blocks. Leaving out an optional
secret just turns that feature off. Leaving out a required one stops the app booting
(`ENVIRONMENT=staging` refuses placeholder secrets).

- [ ] ⌨️ **API** (required: everything except TMDB and Sentry):

      ```bash
      fly secrets set -a fnh-api-staging --stage \
        DATABASE_URL='<from step 3>' MIGRATION_DATABASE_URL='<from step 3>' \
        REDIS_URL='<from step 4>' \
        SESSION_SECRET="$(openssl rand -hex 32)" DEVICE_TOKEN_PEPPER="$(openssl rand -hex 32)" \
        SMTP_HOST=smtp.resend.com SMTP_PORT=587 SMTP_USERNAME=resend \
        EMAIL_API_KEY='<step 6>' EMAIL_FROM='Family Night <movie-night@<domain>>' \
        STORAGE_ACCESS_KEY_ID='<step 5 API key>' STORAGE_SECRET_ACCESS_KEY='<step 5 API secret>' \
        TMDB_READ_TOKEN='<step 7, optional>' SENTRY_DSN='<step 7, optional>'
      ```

- [ ] ⌨️ **Worker.** Its `SESSION_SECRET` / `DEVICE_TOKEN_PEPPER` are **its own random
      values, not the API's**. The worker never uses them, but Settings refuses to load in
      staging/production without them, and the worker crash-loops (verified). Give it no
      email secrets and no `MIGRATION_DATABASE_URL`:

      ```bash
      fly secrets set -a fnh-worker-staging --stage \
        DATABASE_URL='<from step 3>' REDIS_URL='<from step 4>' \
        SESSION_SECRET="$(openssl rand -hex 32)" DEVICE_TOKEN_PEPPER="$(openssl rand -hex 32)" \
        STORAGE_ACCESS_KEY_ID='<step 5 API key>' STORAGE_SECRET_ACCESS_KEY='<step 5 API secret>' \
        SENTRY_DSN='<optional>'
      # production only, and only here:
      # BACKUP_STORAGE_ACCESS_KEY_ID='<backup key>' BACKUP_STORAGE_SECRET_ACCESS_KEY='<…>'
      ```

- [ ] ⌨️ **Web**: no secrets. `API_INTERNAL_URL` is in `web.fly.toml`, and the client bundle
      carries no server value (CI's `bundle-secrets` job).
- [ ] ⌨️ Check: `fly secrets list -a <app>` for each app. Names only; digests change on each set.

> **Known risk, accepted for now.** Fly secrets are per app, not per process, so
> `MIGRATION_DATABASE_URL` (the owner role, which can disable RLS) is also in the running API's
> environment, not just the release machine's. A compromised API process could read it.
> Closing this means running migrations from somewhere else (a separate migrator app, or the
> deploy job over `fly proxy`). Track it as a follow-up; don't block the first deploy on it.

## 9. GitHub environments

- [ ] 🌐 Settings → Environments → **New environment** `staging`, then `production`.
- [ ] 🌐 **`production` first**: tick *Required reviewers* and add yourself, and set
      *Deployment branches* to `main` only. GitHub creates a referenced environment without
      protection, so a token on an unprotected `production` would deploy with no approval.
- [ ] ⌨️ Deploy token for staging. It must deploy three apps, so it's an org token with an
      expiry ([restore.md §0.3](restore.md#0-decide-before-provisioning)). Paste values at
      the prompt so they stay out of shell history:

      ```bash
      fly tokens create org --org <org> --name fnh-deploy-staging --expiry 2160h
      R=one-repo-to-rule-them-all/FamilyNightHub
      gh secret set FLY_API_TOKEN --env staging -R $R
      gh secret set BUCKET_ADMIN_ACCESS_KEY_ID --env staging -R $R       # step 5 admin key
      gh secret set BUCKET_ADMIN_SECRET_ACCESS_KEY --env staging -R $R
      gh variable set PHOTOS_BUCKET --env staging --body fnh-photos-staging -R $R
      ```

      **Do not add `production`'s `FLY_API_TOKEN` yet.** Without it the production job skips
      with a notice, so the first run can only touch staging.

## 10. First deploy (staging)

- [ ] ⌨️ `gh workflow run deploy.yml --ref main -R $R`, then `gh run watch -R $R`.
      (A CI run started by `workflow_dispatch` is not a push, so it doesn't trigger Deploy. Run
      Deploy by hand this first time.) Order inside the job: bucket CORS (set and read back) →
      `fnh-api-staging` (the release machine runs `alembic upgrade head` as `fnh`) →
      `fnh-worker-staging` → `fnh-web-staging` → `GET /api/health` must report
      `status: ok, environment: staging`.
- [ ] ⌨️ If the release command fails: `fly logs -a fnh-api-staging`. *role fnh_app missing* →
      step 3 wasn't run. *permission denied for schema public* → an old copy of the bootstrap
      script; re-run step 3's `-f` line (it's idempotent).
- [ ] ⌨️ After it's green:

      ```bash
      fly scale count 1 -a fnh-worker-staging          # exactly one worker
      fly ips list -a fnh-api-staging                  # only a private v6, no public address
      fly status -a fnh-api-staging; fly status -a fnh-web-staging   # first deploy makes 2
                                                       # Machines each; the 2nd idles stopped
      fly checks list -a fnh-worker-staging            # health passing
      curl -fsS https://fnh-web-staging.fly.dev/api/health
      ```

## 11. First admin

- [ ] ⌨️ Open a shell on the API, check that it sees its environment, then bootstrap. Typing
      it interactively avoids `-C` quoting problems with names that contain spaces:

      ```bash
      fly ssh console -a fnh-api-staging
      # inside the machine:
      printenv ENVIRONMENT                     # → staging
      python -m app.cli bootstrap --household "<Family name>" --slug <join-slug> \
        --email <your email> --name "<Your name>"
      exit
      ```

      It prints the fridge-QR URL (`https://fnh-web-staging.fly.dev/j/<join-slug>`). Choose
      the slug carefully: rotating it later (admin settings) means reprinting the QR.

## 12. Smoke checks on staging (🌐 on a phone)

- [ ] Open `https://fnh-web-staging.fly.dev`, request a sign-in link, and receive the email
      (this proves SMTP and DNS). Sign in, then add two people (admin screens).
- [ ] Start a night and add three typed titles (or TMDB search, if configured). Open voting.
- [ ] On a second phone, scan or open `/j/<join-slug>`, enter the night code, and pick a
      person. Vote. The host screen updates without a reload, which proves SSE over the real
      proxy chain.
- [ ] Close voting, and both phones show the winner. Wait 30 s, add a photo, and check that
      it appears on the other phone. Any CORS error in the console means the bucket rule is
      wrong (rerun Deploy and check its CORS step).
- [ ] `fly logs -a fnh-worker-staging` shows `auto_close_stale_sessions_done` at :10 and
      `sweep_orphan_uploads_done` at :40 past the hour (America/Chicago crons).

## 13. Real-iPhone checklist and restore rehearsal (staging)

- [ ] 🌐 [`photo-drop-iphone-checklist.md`](photo-drop-iphone-checklist.md) on a real iPhone.
- [ ] ⌨️ Restore rehearsal: [restore.md §2.1](restore.md#21-postgres-from-a-fly-snapshot-legacy-fly-postgres)
      from today's snapshot, then note the date under "Rehearsals" there.

## 14. Production

- [ ] Repeat steps 2–8 with production names: `fnh-api`, `fnh-worker`, `fnh-web`,
      `fnh-db`, `fnh-redis` (Fixed plan), buckets `fnh-photos` + `fnh-photos-backup`, and a
      verified email domain. Use **new** passwords and secrets: nothing is shared with staging.
- [ ] ⌨️ Production secrets in GitHub (`--env production`): `BUCKET_ADMIN_*`, plus
      `PHOTOS_BUCKET=fnh-photos`, **then** `FLY_API_TOKEN` last (a separate token,
      `--name fnh-deploy-production`).
- [ ] ⌨️ `gh workflow run deploy.yml --ref main -R $R`. Staging redeploys, then the
      production job waits. 🌐 **Approve** it in the run page. It deploys the **same image
      digests** staging just ran.
- [ ] ⌨️ Step 10's checks and step 11's bootstrap against `fnh-*`. The production QR URL is
      `https://fnh-web.fly.dev/j/<join-slug>`.
- [ ] 🌐 Uptime monitor (e.g. UptimeRobot): `https://fnh-web.fly.dev/api/health` every 5 min,
      alert on non-200.

## 15. Fridge QR

- [ ] ⌨️ Generate it from the URL the production bootstrap printed, and print it:

      ```bash
      uvx --from "qrcode[pil]" qr "https://fnh-web.fly.dev/j/<join-slug>" > fridge-qr.png
      ```

      With no custom domain yet, the QR encodes the fly.dev URL (02 "Known gaps"). Adding a
      domain later means reprinting it.

## 16. After the first family night

- [ ] [`phase1-acceptance.md`](phase1-acceptance.md) "What CI does not prove": record the dates.
- [ ] Scale staging to zero until the next release test (ADR-0013):
      `fly scale count 0 -a fnh-web-staging` (same for `fnh-api-staging` and
      `fnh-worker-staging`), and `fly machine stop <id> -a fnh-db-staging`. Bring it back with
      `fly machine start` on the database and a Deploy run.
- [ ] The first invoice: check the Upstash line against ADR-0013's estimate.

---

## Appendix: every variable the code reads, and where it comes from

Cross-checked on 2026-10-15 against `backend/app/core/config.py`, `frontend/next.config.ts`,
`frontend/docker-entrypoint.sh`, the six fly.tomls, `deploy.yml` and `.env.example`. "toml" means
`deploy/<env>/<app>.fly.toml` `[env]`. Anything not listed keeps its code default (rate limits,
TTLs, timeouts, worker tuning).

| Variable | Set where | Secret? | App(s) | Owner action |
|---|---|---|---|---|
| `ENVIRONMENT` | toml (`staging` / `production`) | no | api, worker | none |
| `DATABASE_URL` (`fnh_app`) | fly secrets | yes | api, worker | step 3 → 8 |
| `MIGRATION_DATABASE_URL` (`fnh` owner) | fly secrets | yes | api (release_command; also in the runtime env, see step 8 risk) | step 3 → 8 |
| `REDIS_URL` | fly secrets | yes | api, worker | step 4 → 8 |
| `SESSION_SECRET`, `DEVICE_TOKEN_PEPPER` | fly secrets | yes | api; worker gets **its own** random pair | step 8 |
| `FRONTEND_BASE_URL` | toml | no | api | none (change with a custom domain) |
| `CORS_ALLOWED_ORIGINS` | toml; also the bucket CORS source | no | api, deploy.yml | none |
| `EMAIL_MODE=smtp`, `SMTP_STARTTLS=true` | toml | no | api | none |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `EMAIL_FROM` | fly secrets (provider-specific) | no, but kept with the key | api | step 6 → 8 |
| `EMAIL_API_KEY` | fly secrets | yes | api | step 6 → 8 |
| `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION` | toml | no | api, worker | rename the bucket if taken (step 5) |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | fly secrets | yes | api, worker | step 5 → 8 |
| `STORAGE_PUBLIC_ENDPOINT` | unset on Fly (local compose only) | no | api | none |
| `BACKUP_STORAGE_*` | fly secrets, **prod worker only** | yes | worker (not read yet) | step 14 |
| `TMDB_READ_TOKEN` | fly secrets (optional) | yes | api | step 7 |
| `TMDB_BASE_URL` | code default (real TMDB) | no | api | none |
| `SENTRY_DSN` | fly secrets (optional) | yes | api, worker | step 7 |
| `WORKER_HEALTH_PORT` | toml (`8081`, matches `[checks]`) | no | worker | none |
| `API_INTERNAL_URL` | toml (`http://fnh-api(-staging).flycast`) | no, server-only | web | none |
| `NODE_ENV`, `NEXT_TELEMETRY_DISABLED`, `PORT`, `HOSTNAME` | toml / Dockerfile | no | web | none |
| `FLY_API_TOKEN` | GitHub environment secret | yes | deploy.yml | step 9 (prod last) |
| `BUCKET_ADMIN_ACCESS_KEY_ID`, `BUCKET_ADMIN_SECRET_ACCESS_KEY` | GitHub environment secret, never Fly | yes | deploy.yml CORS step | step 9 |
| `PHOTOS_BUCKET` | GitHub environment **variable** | no | deploy.yml CORS step | step 9 |

No `NEXT_PUBLIC_*` variable exists. The frontend reads no `process.env` in `src/`, and CI's
`bundle-secrets` job greps the client bundle for every server secret.
