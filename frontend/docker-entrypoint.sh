#!/bin/sh
# Point the build-time /api/* rewrite at this environment's API (see Dockerfile).
# Fails closed: without API_INTERNAL_URL the web app would proxy to a dead .invalid host.
set -eu

PLACEHOLDER="http://fnh-api-internal-url.invalid:8000"

if [ -z "${API_INTERNAL_URL:-}" ]; then
    echo "docker-entrypoint: API_INTERNAL_URL is required (e.g. http://fnh-api.internal:8000)" >&2
    exit 1
fi
case "$API_INTERNAL_URL" in
    http://*|https://*) ;;
    *) echo "docker-entrypoint: API_INTERNAL_URL must be an http(s) origin" >&2; exit 1 ;;
esac
case "$API_INTERNAL_URL" in
    *'|'*|*'\'*|*'&'*) echo "docker-entrypoint: API_INTERNAL_URL has unsafe characters" >&2; exit 1 ;;
esac

# Idempotent across restarts: once replaced, the placeholder is gone and grep finds nothing.
grep -rlF "$PLACEHOLDER" /app/.next /app/server.js 2>/dev/null | while read -r f; do
    sed -i "s|$PLACEHOLDER|${API_INTERNAL_URL%/}|g" "$f"
done

exec "$@"
