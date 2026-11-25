# Architecture

The architecture documentation for Family Night Hub lives in
[`docs/architecture/`](docs/architecture/README.md). Start with the README there — it's the map.

Status: active development, well past the skeleton. Built: device join and accounts/PINs, a movie
shortlist with ranked, approval and pick-one voting, the TV reveal, a private photo album
(phone-processed, presigned Tigris), SSE live updates, the admin surface, five migrations
(0001–0005) and ~15 Playwright specs, behind a gated staging→production deploy on Fly. The chapters
describe the whole intended system; some pieces (for example the platform owner and consent, and
several worker crons) are decided in ADRs but not yet built — each says so where it applies.

- **Chapters** (`docs/architecture/01..07`) — how the system works.
- **Decisions** (`docs/architecture/decisions/ADR-*`) — why the load-bearing choices were made.
