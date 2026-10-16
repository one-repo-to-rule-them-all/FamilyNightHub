# ADR-0001: Host on Fly.io with the OrderUp skeleton (FastAPI + Postgres + ARQ + Next.js)

## Status

Accepted (2026-10-15). Supersedes the "Next.js on Vercel + new dedicated Supabase project" stack in
the original scope doc (2026-10-14).

## Context

The scope doc assumed a new, dedicated Supabase project. The owner's Supabase org is on the free
plan and both free slots are taken (`ctrl-alt-defeat-prod`, `neverforgotten-staging`). Free-plan
limits are counted **per user across all orgs**, so a second free org does not help, and free quotas
(1 GB storage, 5 GB egress) are **org-wide** — an FNH photo overrun could get Ctrl+Alt+Defeat
restricted. Co-hosting inside the CAD project would require turning on public sign-ups and anonymous
auth project-wide, breaking CAD's ADR-0004/0007 guarantees. Free Supabase also has no backups,
and Storage objects are never in DB backups on any plan.

The data here is kids' photos and a family's private history: **private-read**, the opposite of
CAD's public-read posture. The owner already runs OrderUp and MadeFresh on Fly.io with FastAPI,
Postgres (with RLS via a session GUC), Upstash Redis, ARQ and an SSE live feed, and FieldPro uses
Tigris for files. That skeleton, CI and operational knowledge exist today.

## Decision

We will run FNH as three Fly apps per environment — `fnh-web` (Next.js), `fnh-api` (FastAPI,
Python 3.12, SQLAlchemy 2 async, Alembic), `fnh-worker` (ARQ) — with Fly Postgres, Upstash Redis
and a private Tigris bucket, mirroring OrderUp's layout (`deploy/{staging,prod}/*.fly.toml`).
`fnh-web` proxies `/api/*` to `fnh-api` over Fly's private network so auth cookies are
first-party. Mechanics: [`02-environments.md`](../02-environments.md), [`03-backend.md`](../03-backend.md).

## Alternatives considered

**Supabase Pro in a separate org (~$25/mo).** Rejected by the owner. It was the least build effort
(RLS, Realtime, Storage built in), but adds a third platform style and a fixed monthly bill.

**Pause `neverforgotten-staging` / co-host in CAD's project ($0).** Rejected: quotas stay org-wide
(blast radius onto CAD), no backups, auto-pause, and co-hosting changes CAD's auth posture.

**Vercel + Neon + Cloudflare R2 (~$0).** Viable and cheapest, but rebuilds auth and realtime in a
stack none of the owner's apps use; the owner preferred the proven Fly pattern.

## Consequences

- One stack across OrderUp, MadeFresh, FieldPro and FNH: shared patterns, shared pitfalls list.
- **Not $0**: roughly $10–30/mo for machines, Postgres, Redis and storage (verify current Fly
  pricing at setup; see 02). Fly machines can auto-stop, but the API must be awake on movie night.
- We own auth, realtime and backups ourselves — more code than Supabase, covered by ADR-0002/0004/0005.
- **CI obligation:** the Docker Compose stack used locally is the same one CI runs Playwright
  against (no hosted test DB) — see [`07-cicd.md`](../07-cicd.md).
- Revisit if the app ever goes multi-household (consent/COPPA ADR first) or Fly costs exceed value.
