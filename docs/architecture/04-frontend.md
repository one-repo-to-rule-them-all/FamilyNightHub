# 04 — Frontend

Next.js 16 (App Router) + TypeScript strict + Tailwind v4 + shadcn `base-nova` (tokens from
Ctrl+Alt+Defeat, [ADR-0008](decisions/ADR-0008-ctrl-alt-defeat-design-tokens.md)) + TanStack Query.
Deployed as `fnh-web` on Fly. Read the repo's `AGENTS.md` note: Next 16 uses `proxy.ts`, not
`middleware.ts`.

## Route structure

| Group | Routes | Who | Notes |
|---|---|---|---|
| `(public)` | `/j/[slug]`, `/who`, `/s/[session]`, `/history`, `/albums/[session]` | devices | Phone-first, 56px+ tap targets, poster-led |
| host | `/host`, `/host/[session]` | host/admin | Shortlist builder, open/close, proxy vote, approve claims |
| tv | `/tv`, `/tv/[session]` | paired TV device | Large type, QR + night code, turnout tiles, reveal, slideshow |
| admin | `/admin/*` | admin | People, devices, history, movies, photos, settings. Denser tables |
| auth | `/login`, `/auth/callback` | admins/hosts | Magic link |

`proxy.ts` redirects pages based on cookie presence only. That is a UX convenience; the API is the
security boundary.

## Phone state machine

`/s/[session]` renders from the session snapshot: `voting` → poster ballot; `revealed` → winner
card; `tonight` → **Add photos** + album + "Rate later"; `closed` → rating prompt (if not yet rated)
and album. On first open after a night, the home screen shows a "How was *Movie*?" prompt, because
nobody rates during the movie.

**Who-are-you:** a grid of big avatar tiles (emoji + colour + name), not a dropdown. After a ballot
is submitted, the phone shows "Pass to next person", which goes back to the grid.

**Ballot:** tap a poster to make it 1, the next tap makes 2, then 3. Tap again to clear. "Done" is
enabled after the first tap (partial ballots are allowed).

## State management

TanStack Query owns server state, with keys per session snapshot. `useLiveSession(sessionId)` mints
an SSE ticket, opens `EventSource`, invalidates the snapshot on each event, refetches on
`visibilitychange` and on reconnect, and polls every 5s while the stream is down. It exposes
`data-live="ready|reconnecting"` for tests. There is no global client store beyond small UI state.

## Photo drop

`src/lib/photos/` contains `process.ts` (exifr date read, `createImageBitmap`, lazy `heic-to`
worker, canvas to 2048px JPEG plus a 480px thumbnail), `queue.ts` (IndexedDB queue, at most two
parallel PUTs, retry with backoff, resumes on `visibilitychange`) and `upload.ts` (presign → PUT →
complete). The input is `<input type="file" accept="image/*" multiple>`, with no `capture`
attribute and never `image/heic`. See [ADR-0005](decisions/ADR-0005-photo-pipeline-and-storage.md).

The album is a thumbnail grid with a full-screen viewer, the uploader's avatar, and emoji reactions.
The TV slideshow uses the Screen Wake Lock API where supported.

## API client & types

`src/lib/api.ts` is a fetch wrapper with `credentials: "include"` and the CSRF header. Types are
generated from `backend/openapi.json` into `src/types/api.gen.ts`. Don't hand-edit them; CI fails
on drift (FieldPro pattern).

## Where to add new code

New phone screen → `app/(public)/…` plus a hook in `src/hooks/`. New admin table → reuse the
`DataTable` primitive. Never call TMDB or storage from the browser except through presigned URLs.

## What's intentionally **not** here / **not** built yet

- No service-worker offline mode beyond the upload queue. No push notifications.
- No zip download. No light theme toggle (dark only in v1).
- Generator UI, approval/pick-one ballots, and the bulk add for owned titles come in Phase 2.
