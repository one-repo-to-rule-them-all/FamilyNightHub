# Build prompt — Family Night Hub

> Paste this into a **new session with the FamilyNightHub repo** to start building from the architecture docs.

---

You are the builder for **Family Night Hub**. The architecture is designed and documented in this
repo. Implement it faithfully, phase by phase, and keep the docs and the code in sync.

## Read these first (they are the source of truth)

- `docs/architecture/README.md`, then `01-system-context.md`.
- Chapters `02`–`07` for the layer you're building.
- `docs/architecture/decisions/ADR-*`. These are non-negotiable:
  - Fly.io + FastAPI + Postgres + ARQ + Next.js, following the OrderUp skeleton (ADR-0001).
  - Members authenticate with an httpOnly device-token cookie. Joining needs the night code or a host. No localStorage identity (ADR-0002).
  - Every household-scoped table ships `FORCE ROW LEVEL SECURITY` in the same migration. The app role has no BYPASSRLS. The household always comes from the credential (ADR-0003).
  - SSE events are hints with no ballots or tallies. Clients refetch snapshots (ADR-0004).
  - Photos are re-encoded on the phone (GPS stripped), PUT directly to the private bucket, viewed with presigned GETs of 10 minutes or less, and backed up nightly by the worker (ADR-0005).
  - Ballot size `min(3, n-1)`, partial ballots allowed, tallies hidden until reveal, tie-break of first-place votes → head-to-head → stored seed (ADR-0006).

## Phase plan

1. **Phase 1 — Movie night + photo drop (about 4 weekends).**
   - Scaffold copied from OrderUp/FieldPro, Docker Compose, the full CI from `07-cicd.md`, staging and prod on Fly.
   - Join flow, avatar grid, host shortlist (manual plus TMDB poster search), poster ballot, proxy votes.
   - TV turnout, then close and reveal, then history.
   - Photo pipeline, private album, reactions, admin hide/delete, nightly backup, restore runbook.
   - **Acceptance:** a Playwright run where 4 phones and a TV complete a night with photos, CI green, and one real family night on production.
2. **Phase 2 — Ratings, generator, admin.** Ratings prompt, generator (ADR-0007) with the TMDB fake, approval and pick-one modules, admin people/devices/history/movies/settings, bulk add for owned titles.
3. **Phase 3+ (deferred).** Zip export, slideshow polish, Plex/Jellyfin sync, other room types, multi-household (needs a consent ADR first).

Finish Phase 1 (CI green and used once for real) before starting Phase 2.

## Engineering expectations

- Write tests alongside code. Honour the gates in `07-cicd.md`: domain at 100%, the isolation suite, the RLS coverage test, deterministic E2E (no sleeps, no retries), and the bundle-secrets grep.
- Copy rather than reinvent: OrderUp (SSE tickets, Fly tomls, deploy), FieldPro (`cors.py`, ARQ worker + DLQ, rate limiter, test layout), CAD (`globals.css` tokens, `components/ui`, Playwright and axe setup). Record the source commit in a header comment.
- Health checks and Sentry from day one.

## Keep docs and code in sync

Update the relevant chapter in the same PR when architecture shifts. For a new load-bearing
decision, open a new ADR (next number). Never edit an accepted ADR; supersede it instead.

## First move

Confirm the stack and the Phase 1 scope back to me in a few sentences, list the first 3–5 concrete
tasks, then start. Flag any ambiguity in the docs before building on it.
