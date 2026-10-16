# 07 — CI/CD

`ci.yml` exists with the `static`, `unit`, `integration`, `contract` and `bundle-secrets` jobs
(status column below). `e2e` and `deploy.yml` are still intended, not built. It combines OrderUp's
Fly deploy with CAD's "secret never in bundle" and multi-browser Playwright gates. The owner is a
QA/CI engineer, so the bar is **deterministic, trustworthy green**.

## The full pipeline at a glance

```mermaid
flowchart TB
    PR["push / PR"] --> S["static: ruff, mypy, eslint, prettier, tsc"]
    PR --> U["unit: pytest unit + domain 100% + vitest"]
    PR --> I["integration: pytest vs Postgres+Redis+SeaweedFS services (incl. isolation + RLS coverage)"]
    S & U & I --> E["e2e: docker compose (api, worker, web, tmdb-fake, seaweedfs) → Playwright multi-phone + axe"]
    E -- "all green" --> M["merge to main"]
    M --> B["build images → GHCR"] --> ST["deploy staging (release_command migrates)"] --> SM["smoke: /api/health + scripted join/vote"] --> G["manual approval"] --> P["deploy prod (same digest)"]
```

## CI jobs

| Job | Purpose | Source of truth | Status |
|---|---|---|---|
| `static` | ruff check + format, mypy strict, repo rules (`backend/scripts/check_repo_rules.py`: no sleeps/fixed waits in tests, no session-level `app.*` GUC, revision ids of 32 chars or fewer), `tsc --noEmit` | `.github/workflows/ci.yml` | Built. eslint/prettier land with the first real UI |
| `unit` | pytest `tests/unit` (+ Hypothesis tally properties), vitest (photo pipeline incl. GPS-strip fixture) | `backend/tests/unit`, `frontend/src/**/*.test.ts` | pytest built; vitest lands with the photo pipeline |
| `integration` | Whole pytest suite against Postgres + Redis service containers as `fnh_app`, after the role bootstrap. **Includes the isolation suite** (two seeded households, every table) and `test_rls_coverage`. Coverage gates run here | `backend/tests/integration` | Built. SeaweedFS service joins with the photo endpoints; endpoint-level isolation joins with the endpoints |
| `contract` | `alembic upgrade` → `downgrade base` → `upgrade` round trip, `alembic check` (models match migrations), `openapi.json` + `api.gen.ts` drift | ci.yml | Built |
| `e2e` | compose stack, Playwright: 4 phone contexts (iPhone + Pixel descriptors) + TV context; unauthenticated context must get 0 photo URLs; axe | `frontend/e2e/` | Not built |
| `bundle-secrets` | `next build` with sentinel values for every server secret, then grep `.next/static` for each. Verified by a deliberate leak (`next.config` `env` + client component) that the grep catches | ci.yml | Built |

`ENVIRONMENT=test` in CI. TypeScript types come from `openapi-typescript`, installed in its own
package (`frontend/tools/openapi/`) because it needs a TypeScript 5 peer and the app runs
TypeScript 7.

**Coverage / quality gates:** `app/domain/**` at 100% line coverage, services at 80% or more,
overall at 70% or more (all three enforced in the `integration` job), with ratchets that only go up. Any test using `waitForTimeout` or `sleep`
fails lint. E2E retries = 0 on PRs. A flaky test is quarantined with an issue, never retried into
green.

**E2E determinism rules:** wait for `data-live="ready"` before acting; assert on server-derived
text with `expect.poll`/`toHaveText`; tie-break seeds are injected through a test-only header that
is accepted only when `ENVIRONMENT=test`; TMDB is always `tmdb-fake`.

## Deploy workflow

On a merge to `main`, `deploy.yml` builds one image for api and worker and one for web, then
pushes them to GHCR tagged with the SHA. It deploys staging (`fly deploy --image …`), where the
release command runs Alembic, then runs a smoke test. The `production` GitHub environment requires
the owner's approval and deploys the **same digests**. Rollback means redeploying the previous
digest. Migrations are expand/contract, so rolling back code never needs a down-migration.

## Secrets map

| Secret | Where stored | Consumed by |
|---|---|---|
| `FLY_API_TOKEN` (staging, prod) | GitHub environments | deploy.yml |
| `GHCR` push | `GITHUB_TOKEN` | deploy.yml |
| App secrets | `fly secrets` (see [`02-environments.md`](02-environments.md)) | Fly apps |
| CI test secrets | none needed (local services, tmdb-fake) | — |

## What CI does NOT enforce

Worth knowing so you don't assume green means safe:
- Real iOS Safari HEIC behaviour. WebKit in Playwright is not iOS, so there is a manual iPhone checklist before each release that touches photos.
- Live TMDB terms and parameter behaviour, because CI uses the fake. Re-verify against the live docs before building the generator.
- Load, backup restore (rehearsed manually), and keeping the docs in sync with the code.
