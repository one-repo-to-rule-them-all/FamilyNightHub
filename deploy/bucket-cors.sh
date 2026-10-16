#!/usr/bin/env bash
# Sets the photos bucket's CORS rule for the web origin (ADR-0005), then reads it back.
# Run by .github/workflows/deploy.yml before each environment's Fly deploys.
#
#   deploy/bucket-cors.sh deploy/staging/api.fly.toml
#
# Phones PUT photos straight to the private bucket and load them through presigned GETs, both
# cross-origin, so the bucket must allow the web origin: PUT with `Content-Type`, and GET.
# The Tigris twin of frontend/e2e/setup_bucket.py (which does this for SeaweedFS in CI), minus
# the bucket creation: deployed buckets are provisioned by hand (runbook restore.md §1.4).
#
# The allowed origins are the API's CORS_ALLOWED_ORIGINS from that environment's api.fly.toml,
# so the bucket and the API can't disagree about who the web origin is. Idempotent:
# put-bucket-cors replaces the whole rule set.
#
# Env: PHOTOS_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (a bucket-admin key that lives
# only in the GitHub environment, never the API's STORAGE_* key), optional STORAGE_ENDPOINT
# (default Tigris).
set -euo pipefail

api_toml="${1:?usage: bucket-cors.sh <api.fly.toml>}"
: "${PHOTOS_BUCKET:?PHOTOS_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
endpoint="${STORAGE_ENDPOINT:-https://fly.storage.tigris.dev}"
export AWS_REGION=auto AWS_PAGER=""

# JSON array of origins. Each must be a bare https origin: a path or trailing slash never
# matches the browser's Origin header, and a wildcard would let any site use the presigned URLs.
origins="$(python3 - "$api_toml" <<'PY'
import json, re, sys, tomllib

with open(sys.argv[1], "rb") as f:
    raw = tomllib.load(f).get("env", {}).get("CORS_ALLOWED_ORIGINS", "")
origins = [o.strip() for o in raw.split(",") if o.strip()]
if not origins:
    sys.exit(f"{sys.argv[1]}: [env] CORS_ALLOWED_ORIGINS is empty")
for o in origins:
    if not re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]+)?", o):
        sys.exit(f"{sys.argv[1]}: {o!r} is not a bare https origin")
print(json.dumps(origins))
PY
)"

rule="$(jq -n --argjson origins "$origins" '{CORSRules: [{
  AllowedOrigins: $origins,
  AllowedMethods: ["PUT", "GET"],
  AllowedHeaders: ["content-type"],
  MaxAgeSeconds: 600
}]}')"

aws s3api put-bucket-cors --endpoint-url "$endpoint" --bucket "$PHOTOS_BUCKET" \
  --cors-configuration "$rule"

# Read it back. Header names are case-insensitive, and stores differ on how they echo them.
normalize='[.CORSRules[] | {
  o: (.AllowedOrigins | sort),
  m: (.AllowedMethods | map(ascii_upcase) | sort),
  h: ((.AllowedHeaders // []) | map(ascii_downcase) | sort),
  a: .MaxAgeSeconds
}]'
actual="$(aws s3api get-bucket-cors --endpoint-url "$endpoint" --bucket "$PHOTOS_BUCKET")"
if [ "$(jq -cS "$normalize" <<<"$actual")" != "$(jq -cS "$normalize" <<<"$rule")" ]; then
  echo "::error title=Bucket CORS mismatch::$PHOTOS_BUCKET reads back a different rule than was set"
  jq . <<<"$actual"
  exit 1
fi
echo "::notice title=Bucket CORS::$PHOTOS_BUCKET allows PUT/GET from $(jq -r 'join(", ")' <<<"$origins")"
