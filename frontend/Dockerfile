# fnh-web: Next.js standalone server (ADR-0001). One image for staging AND production
# (07-cicd.md promotes the same digest), so nothing environment-specific is baked in.
# Multi-stage, non-root. Based on OrderUp frontend/Dockerfile @ 2f86cd8.
#
# The catch: Next evaluates `rewrites()` at build time and freezes the destination into
# .next/routes-manifest.json, so API_INTERNAL_URL set on Fly would be ignored. The build
# therefore uses a placeholder origin, and docker-entrypoint.sh swaps in the runtime
# API_INTERNAL_URL before starting the server. Server-only: never NEXT_PUBLIC_*.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV API_INTERNAL_URL=http://fnh-api-internal-url.invalid:8000
RUN npm run build \
    && grep -q "fnh-api-internal-url.invalid" .next/standalone/.next/routes-manifest.json

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && chown nextjs:nodejs /app

# Owned by nextjs (and /app itself, for sed -i temp files): the entrypoint rewrites the
# placeholder in place at boot.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
