#!/usr/bin/env bash
# Provision Family Night Hub STAGING on Fly.io: steps 2-9 of docs/runbooks/first-deploy.md.
#
#   bash deploy/scripts/provision-staging.sh            # from the repo root, in Git Bash
#
# Run by the OWNER in their own terminal. It is interactive on purpose:
#   * every password it can generate (owner role, app role, session secret, pepper) is
#     generated here with openssl and goes straight into `fly secrets set` / psql;
#   * every credential a provider prints or a console issues (Postgres superuser password,
#     Upstash URL, Tigris keys, Resend key, optional TMDB token / Sentry DSN) is pasted at a
#     HIDDEN prompt;
#   * the Fly deploy token is piped from `fly tokens create` into `gh secret set`, never shown.
# Nothing secret is written to disk, echoed, or committed. Keep the values the providers show
# you in your password manager as you go (production needs NEW ones; never reuse them).
#
# Idempotent: re-running skips apps/buckets/databases that exist, and re-sets passwords and
# secrets (so a rerun rotates the generated ones consistently on both sides).
#
# Needs: fly (logged in: `fly auth login`), gh (logged in, repo admin), openssl, and either
# psql 16 or Docker (it falls back to the postgres:16 image for psql).
set -euo pipefail

ORG="${ORG:-personal}"
REGION="${REGION:-dfw}"
REPO="${REPO:-one-repo-to-rule-them-all/FamilyNightHub}"
API=fnh-api-staging
WORKER=fnh-worker-staging
WEB=fnh-web-staging
DB=fnh-db-staging
REDIS=fnh-redis-staging
BUCKET=fnh-rbj-photos-staging
PROXY_PORT="${PROXY_PORT:-15432}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOTSTRAP_SQL="$ROOT/backend/db/init/00-init-app-role.sql"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
confirm() { local a; read -rp "   $1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
# Hidden prompt into a named variable; refuses empty unless optional.
secret() {
  local var="$1" label="$2" optional="${3:-}" val=""
  while :; do
    read -rsp "   $label${optional:+ (Enter to skip)}: " val; echo
    [[ -n "$val" || -n "$optional" ]] && break
    note "Required."
  done
  printf -v "$var" '%s' "$val"
}
gen() { openssl rand -hex "${1:-24}"; }
app_exists() { fly status -a "$1" >/dev/null 2>&1 || fly apps list 2>/dev/null | grep -qw "$1"; }

for t in fly gh openssl; do command -v "$t" >/dev/null || die "$t is not installed."; done
fly auth whoami >/dev/null 2>&1 || die "Run 'fly auth login' first."
gh auth status >/dev/null 2>&1 || die "Run 'gh auth login' first."
[[ -f "$BOOTSTRAP_SQL" ]] || die "Run from a checkout of the repo ($BOOTSTRAP_SQL not found)."

if command -v psql >/dev/null; then
  PG_HOST=127.0.0.1
  psql_super() { PGPASSWORD="$SUPER_PW" psql -h "$PG_HOST" -p "$PROXY_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }
else
  command -v docker >/dev/null || die "Need psql 16 or Docker."
  # Docker Desktop's host.docker.internal reaches the host's loopback, where `fly proxy` listens.
  PG_HOST=host.docker.internal
  psql_super() {
    docker run --rm -i -e PGPASSWORD="$SUPER_PW" postgres:16 \
      psql -h "$PG_HOST" -p "$PROXY_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"
  }
fi

say "Family Night Hub: provision STAGING in Fly org '$ORG', region '$REGION'"
note "Creates: 3 apps, Postgres ($DB), Upstash Redis ($REDIS), Tigris bucket ($BUCKET),"
note "Fly secrets, and GitHub environments 'staging' + 'production' (production protected)."
note "Cost while running is roughly \$20-30/mo; scale it to zero after testing (runbook)."
confirm "Continue?" || exit 0

# --- Step 2: apps -------------------------------------------------------------------
say "Step 2: apps"
for app in "$API" "$WORKER" "$WEB"; do
  if app_exists "$app"; then note "$app exists"; else fly apps create "$app" --org "$ORG"; fi
done
# Match the JSON type field: the table output also prints a docs link containing "private",
# which made a fresh app look allocated (and the web's .flycast URL then fails).
if fly ips list -a "$API" --json 2>/dev/null | grep -q '"Type": *"private_v6"'; then
  note "$API already has a private address"
else
  fly ips allocate-v6 --private -a "$API"
fi

# --- Step 3: Postgres + role bootstrap ------------------------------------------------
say "Step 3: Postgres ($DB) and the role bootstrap"
if app_exists "$DB"; then
  note "$DB exists."
else
  note "Creating the cluster. If asked, choose the UNMANAGED / legacy Postgres, single node."
  note "SAVE the 'postgres' superuser password it prints; you'll paste it next."
  note "Never run 'fly postgres attach' (it would create a superuser app connection)."
  fly postgres create --name "$DB" --org "$ORG" --region "$REGION" \
    --vm-size shared-cpu-1x --volume-size 1 --initial-cluster-size 1
fi
secret SUPER_PW "Paste the 'postgres' superuser password for $DB"

note "Opening a private tunnel: fly proxy $PROXY_PORT:5432 -a $DB"
fly proxy "$PROXY_PORT:5432" -a "$DB" >/dev/null 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  (echo >"/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null && break
  sleep 1
done
(echo >"/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null || die "fly proxy didn't come up on $PROXY_PORT."

OWNER_PW="$(gen)"
APP_PW="$(gen)"
psql_super -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fnh') THEN
    CREATE ROLE fnh LOGIN CREATEROLE NOSUPERUSER PASSWORD '$OWNER_PW';
  ELSE
    ALTER ROLE fnh LOGIN CREATEROLE NOSUPERUSER PASSWORD '$OWNER_PW';
  END IF;
END
\$\$;
SQL
if ! psql_super -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'fnh'" | grep -q 1; then
  psql_super -d postgres -q -c "CREATE DATABASE fnh OWNER fnh;"
fi
psql_super -d fnh -q -f - <"$BOOTSTRAP_SQL"
psql_super -d fnh -q <<SQL
ALTER ROLE fnh_app PASSWORD '$APP_PW';
SQL
note "Roles (expect: fnh = Create role, fnh_app = none, fnh_resolver = Cannot login):"
psql_super -d fnh -c '\du fnh*'

kill "$PROXY_PID" 2>/dev/null || true
trap - EXIT

# JSON, not the table: the table rows start with a box-drawing character, so matching
# /^vol_/ found nothing and retention was skipped silently (restore rehearsal, 2026-10-17).
VOL_ID="$(fly volumes list -a "$DB" --json 2>/dev/null | grep -oE '"id": *"vol_[a-z0-9]+"' | head -1 | grep -oE 'vol_[a-z0-9]+' || true)"
if [[ -n "$VOL_ID" ]] && fly volumes update "$VOL_ID" -a "$DB" --snapshot-retention 7 >/dev/null 2>&1; then
  note "Snapshot retention on $VOL_ID: 7 days"
else
  note "WARNING: couldn't set snapshot retention to 7 days; set it by hand (runbook step 3)."
fi

DATABASE_URL="postgresql+asyncpg://fnh_app:${APP_PW}@${DB}.flycast:5432/fnh"
MIGRATION_DATABASE_URL="postgresql+psycopg2://fnh:${OWNER_PW}@${DB}.flycast:5432/fnh"

# --- Step 4: Redis ---------------------------------------------------------------------
say "Step 4: Redis ($REDIS)"
if fly redis list 2>/dev/null | grep -qw "$REDIS"; then
  note "$REDIS exists. 'fly redis status $REDIS' shows its URL."
else
  note "Pick the PAY-AS-YOU-GO plan for staging. Copy the redis:// URL it prints."
  fly redis create --name "$REDIS" --org "$ORG" --region "$REGION" --no-replicas
fi
secret REDIS_URL "Paste the Redis URL (redis:// or rediss://)"

# --- Step 5: Tigris ----------------------------------------------------------------------
say "Step 5: Tigris bucket ($BUCKET)"
if fly storage list 2>/dev/null | grep -qw "$BUCKET"; then
  note "$BUCKET exists. Use its read/write key from the Tigris console."
else
  note "Creating it (private; not attached to an app). Copy the access key pair it prints:"
  note "that pair is the API's read/write key."
  fly storage create --name "$BUCKET" --org "$ORG"
fi
secret STORAGE_ACCESS_KEY_ID "Paste STORAGE access key id (read/write, this bucket)"
secret STORAGE_SECRET_ACCESS_KEY "Paste STORAGE secret access key"
note "Now open the Tigris console:  fly storage dashboard $BUCKET"
note "  1) confirm that key is Editor on THIS bucket only, not Admin;"
note "  2) create a second key: Admin on THIS bucket only (for the CORS rule; GitHub only)."
secret BUCKET_ADMIN_ACCESS_KEY_ID "Paste the bucket-ADMIN access key id"
secret BUCKET_ADMIN_SECRET_ACCESS_KEY "Paste the bucket-ADMIN secret access key"

# --- Step 6: email -----------------------------------------------------------------------
say "Step 6: email (Resend over SMTP, STARTTLS 587)"
note "Resend: create the account, add + verify your sending domain (DNS), then"
note "API Keys -> Create (Sending access, that domain). Before the domain verifies you can"
note "use the sender onboarding@resend.dev, which only delivers to your own Resend address."
secret EMAIL_API_KEY "Paste the Resend API key"
read -rp "   EMAIL_FROM [Family Night <onboarding@resend.dev>]: " EMAIL_FROM
EMAIL_FROM="${EMAIL_FROM:-Family Night <onboarding@resend.dev>}"

# --- Step 7: optional --------------------------------------------------------------------
say "Step 7: optional integrations"
secret TMDB_READ_TOKEN "TMDB v4 read access token" optional
secret SENTRY_DSN "Sentry DSN" optional

# --- Step 8: Fly secrets -----------------------------------------------------------------
say "Step 8: Fly secrets (staged; nothing restarts)"
api_secrets=(
  "DATABASE_URL=$DATABASE_URL"
  "MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL"
  "REDIS_URL=$REDIS_URL"
  "SESSION_SECRET=$(gen 32)"
  "DEVICE_TOKEN_PEPPER=$(gen 32)"
  "SMTP_HOST=smtp.resend.com" "SMTP_PORT=587" "SMTP_USERNAME=resend"
  "EMAIL_API_KEY=$EMAIL_API_KEY"
  "EMAIL_FROM=$EMAIL_FROM"
  "STORAGE_ACCESS_KEY_ID=$STORAGE_ACCESS_KEY_ID"
  "STORAGE_SECRET_ACCESS_KEY=$STORAGE_SECRET_ACCESS_KEY"
)
[[ -n "$TMDB_READ_TOKEN" ]] && api_secrets+=("TMDB_READ_TOKEN=$TMDB_READ_TOKEN")
[[ -n "$SENTRY_DSN" ]] && api_secrets+=("SENTRY_DSN=$SENTRY_DSN")
fly secrets set -a "$API" --stage "${api_secrets[@]}" >/dev/null
note "$API: ${#api_secrets[@]} secrets set"

# The worker gets its OWN session secret/pepper (it never uses them, but Settings refuses
# placeholders in staging), no email and no MIGRATION_DATABASE_URL.
worker_secrets=(
  "DATABASE_URL=$DATABASE_URL"
  "REDIS_URL=$REDIS_URL"
  "SESSION_SECRET=$(gen 32)"
  "DEVICE_TOKEN_PEPPER=$(gen 32)"
  "STORAGE_ACCESS_KEY_ID=$STORAGE_ACCESS_KEY_ID"
  "STORAGE_SECRET_ACCESS_KEY=$STORAGE_SECRET_ACCESS_KEY"
)
[[ -n "$SENTRY_DSN" ]] && worker_secrets+=("SENTRY_DSN=$SENTRY_DSN")
fly secrets set -a "$WORKER" --stage "${worker_secrets[@]}" >/dev/null
note "$WORKER: ${#worker_secrets[@]} secrets set"
note "$WEB: no secrets (API_INTERNAL_URL is in web.fly.toml)"

# --- Step 9: GitHub environments ----------------------------------------------------------
say "Step 9: GitHub environments"
gh api -X PUT "repos/$REPO/environments/staging" >/dev/null
note "environment 'staging' ready"
# production FIRST gets protection: required reviewer (you) and main-only deployments, so a
# token added later can never deploy without approval.
ME_ID="$(gh api user --jq .id)"
gh api -X PUT "repos/$REPO/environments/production" --input - >/dev/null <<JSON
{"reviewers":[{"type":"User","id":$ME_ID}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api "repos/$REPO/environments/production/deployment-branch-policies" --jq '.branch_policies[].name' 2>/dev/null \
  | grep -qx main \
  || gh api -X POST "repos/$REPO/environments/production/deployment-branch-policies" \
       -f name=main -f type=branch >/dev/null
note "environment 'production': required reviewer + main only (no secrets yet, by design)"

printf '%s' "$BUCKET_ADMIN_ACCESS_KEY_ID" | gh secret set BUCKET_ADMIN_ACCESS_KEY_ID --env staging -R "$REPO"
printf '%s' "$BUCKET_ADMIN_SECRET_ACCESS_KEY" | gh secret set BUCKET_ADMIN_SECRET_ACCESS_KEY --env staging -R "$REPO"
gh variable set PHOTOS_BUCKET --env staging --body "$BUCKET" -R "$REPO"
# Org deploy token (it deploys three apps), 90-day expiry, piped straight into GitHub.
fly tokens create org --org "$ORG" --name fnh-deploy-staging --expiry 2160h \
  | gh secret set FLY_API_TOKEN --env staging -R "$REPO"
note "staging: FLY_API_TOKEN, BUCKET_ADMIN_* secrets and PHOTOS_BUCKET variable set"

unset SUPER_PW OWNER_PW APP_PW DATABASE_URL MIGRATION_DATABASE_URL REDIS_URL EMAIL_API_KEY \
  STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY BUCKET_ADMIN_ACCESS_KEY_ID \
  BUCKET_ADMIN_SECRET_ACCESS_KEY TMDB_READ_TOKEN SENTRY_DSN

say "Done: staging is provisioned (runbook steps 2-9)."
note "Check names only:  fly secrets list -a $API ; fly secrets list -a $WORKER"
note "Next (runbook step 10): the first deploy. Tell Claude 'staging provisioned'."
