# ADR-0013: Correct the hosting cost, self-operated Postgres, and scale staging to zero

## Status

Proposed (2026-10-15). Corrects the cost line of [ADR-0001](ADR-0001-fly-fastapi-postgres-hosting.md)
("roughly $10–30/mo, verify current Fly pricing at setup"). ADR-0001's decision itself (Fly.io,
three apps per environment, Postgres, Upstash, Tigris) stands. **Owner decision needed before
provisioning** ([`runbooks/first-deploy.md`](../../runbooks/first-deploy.md) step 0).

## Context

ADR-0001's estimate predates Fly's Managed Postgres (MPG) and was never checked against an
actual configuration. Prices below were read from the vendors' pages on 2026-10-15; the ARQ
command rate was measured, not assumed.

| Line item | Price | Source |
|---|---|---|
| `shared-cpu-1x` 512 MB, always on, `dfw` | $4.61/mo (iad base $3.69 × dfw 1.25) | fly.io/docs/about/pricing |
| `shared-cpu-1x` 256 MB, always on, `dfw` | $2.74/mo | same |
| Stopped Machine | rootfs only, $0.15/GB/mo | same |
| Volume / snapshots | $0.15/GB/mo / $0.08/GB/mo, first 10 GB of snapshots free | same |
| Free allowance for new orgs | none (trial only) | same |
| **MPG Basic** (smallest plan), storage | **$38/mo**, + $0.28/GB/mo | fly.io/docs/mpg |
| Legacy `fly postgres create` | a Machine + a volume; docs **archived**, product "no longer maintained", unsupported | fly.io/docs/postgres |
| Upstash pay-as-you-go | $0.20 per 100K commands (500K/mo free tier) | upstash.com/pricing/redis |
| Upstash Fixed 250 MB | $10/mo flat, no per-command billing | same; `fly redis create` sells the same plans |
| Tigris | $0.02/GB/mo, free egress, free tier 5 GB | tigrisdata.com/pricing |
| Shared IPv4 / IPv6 / Flycast | free | fly.io/docs/about/pricing |
| Egress (North America) | $0.02/GB | same |

Two findings change the picture:

1. **MPG costs more than the whole ADR-0001 budget, and it does not fit ADR-0003/0009.**
   MPG Basic alone is $38/mo per environment. MPG gives no superuser: its users are
   `schema_admin`, `writer` and `reader`, created with `fly mpg users create`, and CREATEROLE is
   not documented. Our role model needs `CREATE ROLE fnh_app ... NOBYPASSRLS`, a `NOLOGIN`
   role `fnh_resolver` that owns the SECURITY DEFINER resolvers, and `ALTER DEFAULT
   PRIVILEGES FOR ROLE fnh` (`backend/db/init/00-init-app-role.sql`). None of that is shown to
   be possible on MPG, so adopting MPG would mean reworking ADR-0009, not just a provisioning
   change.
2. **An idle ARQ worker costs about $10/mo on Upstash pay-as-you-go.** Measured on the
   prod-like stack: the worker issues one `ZRANGEBYSCORE` every 0.5 s (`poll_delay`) whether or
   not any job exists, 2 commands/s, ≈5.2M commands/month, ≈$10.40/mo per environment.
   Every FNH task is a cron, so this polling buys nothing.

A shared Postgres cluster for staging and production (two databases) is **not** an option:
`fnh`, `fnh_app` and `fnh_resolver` are cluster-wide roles, so both environments would share
role passwords, and staging credentials could connect to the production database.

## Decision

1. **Postgres: self-operated, not MPG.** Use legacy Fly Postgres (`fly postgres create`,
   shared-cpu-1x 512 MB, 1 GB volume, ≈$4.76/mo), which is what
   [`restore.md`](../../runbooks/restore.md) is written for. If Fly refuses to create it
   for a new org, run the official `postgres:16` image as an ordinary Fly app with a volume
   (same cost, same superuser, same SQL; a `deploy/<env>/db.fly.toml` is a follow-up). Either
   way it gets no public IP, only Flycast. Revisit MPG when it documents a role with
   CREATEROLE, or if an outage we caused ourselves costs more than $33/mo of convenience.
2. **Redis: Upstash Fixed 250 MB ($10/mo) for production**, pay-as-you-go for staging. No
   code change is needed for the first deploy. Follow-up: raise ARQ `poll_delay` (crons only,
   so a few seconds of lateness is harmless). At 10 s the idle rate falls to about 260K
   commands/month, and production can move to pay-as-you-go at roughly $0–1/mo.
3. **Staging scales to zero between test sessions.** It exists to test on a real iPhone
   before a release (02), not to serve traffic. Stop its Machines (`fly scale count 0` on
   the three apps, and `fly machine stop` on its Postgres) when you're done, and start them
   before the next release test. Stopped, it bills rootfs plus volumes, about $1/mo.
4. Keep everything else from ADR-0001 and 02: `shared-cpu-1x`/512 MB, `min_machines_running = 1`
   on web and api, and one always-on worker.

## Estimated monthly cost

| Scenario | Per environment | Total |
|---|---|---|
| **As written in 02** (MPG Basic + Upstash PAYG, staging and prod always on) | 3 × $4.61 + $38.28 + $10.40 + Tigris ≈ $62.50 | **≈ $125/mo** |
| As written, staging scaled to zero (its MPG destroyed: MPG can't be stopped) | prod $62.50 + staging ≈ $1 | **≈ $64/mo** |
| **This ADR, staging scaled to zero** (recommended) | prod: $13.84 machines + $4.76 Postgres + $10 Upstash Fixed + ≈$0.10 Tigris/egress = $28.70; staging stopped ≈ $1 | **≈ $30/mo** |
| This ADR, staging always on | prod $28.70 + staging $13.84 + $4.76 + ≈$10.40 PAYG | **≈ $58/mo** |
| This ADR + `poll_delay` follow-up, staging scaled to zero | prod ≈ $19.70 + staging ≈ $1 | **≈ $21/mo** |

First-deploy extras: the HA second Machine that `fly deploy` creates for web and api sits stopped
under `auto_stop_machines` (pennies of rootfs). The release-command Machine bills seconds.

## Consequences

- The real floor for a prod-only Fly footprint is about $20–30/mo. That is the top of
  ADR-0001's range, not its middle, and staging always on would roughly double it.
- We operate Postgres ourselves: minor-version upgrades, volume snapshot retention (set it to
  7 days), and restore rehearsals ([`restore.md`](../../runbooks/restore.md) §2). Legacy Fly
  Postgres images are no longer updated by Fly, so watch for a Postgres CVE that matters.
  The database has no public IP, which limits exposure.
- Staging is cold by default. Bring it up before each release that needs an iPhone check;
  budget about a minute for Machines to start.
- Upstash pub/sub billing (one SUBSCRIBE versus each delivered message) is not documented.
  At family scale it is at most a few thousand commands per night either way. Confirm on the
  first month's invoice.
- If the owner prefers MPG anyway, the price is about $38/mo per environment, and ADR-0009's
  resolver role needs a rework first, because MPG cannot create it.
