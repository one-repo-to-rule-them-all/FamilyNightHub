# ADR-0007: The candidate generator draws from owned titles first, then subscribed streaming, then all of TMDB

## Status

Proposed (2026-10-15). Generator ships in Phase 2. Phase 1 uses a manual shortlist.

## Context

The scope's flow (random TMDB titles in a genre, then the host ticks the ones he owns) rarely
works. With 20 owned titles in a 500-title genre pool, a 12-title roll contains 3 owned titles
only about 1% of the time. Owned titles are entered by hand, with a bulk add (owner decision).
TMDB terms, filters and watch-provider attribution (JustWatch) were researched from a mirror of the
TMDB spec and must be re-checked live before build.

## Decision

- Sources in order: **owned** (`movies.owned`), then **streaming** (TMDB discover with
  `with_watch_providers=<household services>&watch_region=US&with_watch_monetization_types=flatrate`),
  then **anywhere** (TMDB discover with a `vote_count.gte` floor, a random page within
  `min(total_pages, 50)`, then shuffle).
- Filters: genre, max runtime, and an **age cap per session** (default from settings), enforced
  both in the TMDB query (`certification_country=US&certification.lte=…`) and locally against
  the cached US certification. Unrated titles are excluded on capped nights.
- History-aware: skip titles watched in the last 12 months unless their **average** family rating is
  4 or higher. Blocklisted titles are always skipped.
- All TMDB calls happen in `fnh-api` (`app/integrations/tmdb.py`) with responses cached in
  `tmdb_cache`. The UI shows TMDB attribution, plus JustWatch attribution wherever streaming data
  is shown.

## Alternatives considered

**Scope flow (random then tick).** Rejected: hit-rate math above.

**Plex/Jellyfin sync now.** Deferred: Vercel/Fly would need the home server exposed (tunnel). It
gets its own ADR later.

## Consequences

- The owned library must be seeded before the generator is useful. Bulk add ships with it.
- **Tests:** the generator takes an injected seeded RNG, so its output is deterministic. TMDB is
  stubbed with a FastAPI fake (`TMDB_BASE_URL`) built from recorded fixtures. CI never calls TMDB.
- See [`03-backend.md`](../03-backend.md) "Candidates".
