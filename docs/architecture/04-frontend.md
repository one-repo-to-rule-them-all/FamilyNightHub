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

`src/proxy.ts` redirects pages based on cookie presence only. That is a UX convenience; the API is
the security boundary. Today: `/who` without `fnh_device` → `/`; `/host/*` without `fnh_session` →
`/login`; `/login` with `fnh_session` → `/host`.

**Built so far** (the rest of the table is still the plan):

| Route | File | What it does |
|---|---|---|
| `/` | `src/app/page.tsx` | "Scan the QR" landing |
| `/j/[slug]` | `src/app/(public)/j/[slug]/` | Night-code entry → `POST /api/v1/join` → `/who`. Forgiving input (`src/lib/night-code.ts`: case, spaces, dashes; flags 0/O/1/I/L before sending). Shows the server's generic error, plus "Try again in N minutes" from `Retry-After` on a 429 |
| `/who` | `src/app/(public)/who/` | Avatar grid from `GET /api/v1/people`; tiles show `mine` / `pending` / `taken` / `free`; a tap is `PUT /api/v1/devices/me/people/{id}`, then the grid refetches. Claiming a `taken` person makes it `pending` ("ask the host"). Once the phone holds someone, a "Vote now" / "See tonight's movie" button links to the household's live night (`GET /api/v1/sessions?status=voting&status=revealed&status=tonight&limit=1`) |
| `/s/[session]` | `src/app/(public)/s/[session]/` | The night from the snapshot (`GET /api/v1/sessions/{id}`) via `useLiveSession`; see "Phone state machine" below. `draft` → "Almost ready"; `voting` → ballot (`voting-flow.tsx`); `revealed` → winner card + the rest of the ranking; `tonight` → winner + a placeholder where the photo drop goes; `closed` → summary + link to history |
| `/history` | `src/app/(public)/history/` | Past nights from `GET /api/v1/sessions` (server default: revealed, tonight, closed): winner poster, date, turnout; each links to its `/s/[session]` |
| `/login` | `src/app/(auth)/login/` | Email → `POST /api/v1/auth/magic-link`; shows the server's one answer, which is the same whether or not the address exists |
| `/auth/callback?token=` | `src/app/(auth)/auth/callback/` | `POST /api/v1/auth/verify` once (guarded against StrictMode's double effect), then `router.replace("/host")` so the spent token leaves history. `referrer: no-referrer` |
| `/host` | `src/app/host/` | Placeholder: who is signed in, and sign out |

## Design system

[ADR-0008](decisions/ADR-0008-ctrl-alt-defeat-design-tokens.md): `src/app/globals.css` and
`src/components/ui/{button,input,card,label}.tsx` are copied from Ctrl+Alt+Defeat @ `dcbda7d` (the
header comment of each file records the commit and what FNH changed). Tailwind v4, shadcn
`base-nova` (`components.json`), Geist via the `geist` package (local font files, so builds never
fetch Google Fonts).

- **Dark only.** The dark values live on `:root`; `<html class="dark">` keeps the primitives'
  `dark:` variants on.
- **One accent:** `--accent-cinema` (marquee red/amber; `bg-cinema`, `text-cinema`,
  `bg-cinema-muted`). `--primary` points at it, so the default `Button` *is* the accent: use it for
  the one primary action on a screen, and for winners (`marquee-glow`). Everything else is
  `outline` / `secondary` / `ghost`.
- **Tap targets ≥ 56px.** `Button size="tap"` (`h-14`) and `h-14`+ inputs on phone screens.
  Avatar tiles are 160px tall.

## Phone state machine

`/s/[session]` renders from the session snapshot: `voting` → poster ballot; `revealed` → winner
card; `tonight` → **Add photos** + album + "Rate later"; `closed` → rating prompt (if not yet rated)
and album. On first open after a night, the home screen shows a "How was *Movie*?" prompt, because
nobody rates during the movie.

**Built:** `draft`, `voting`, `revealed` (winner card from `result.winner_option_id`, plus the
other placements and "N people voted"), `tonight` (winner + a dashed placeholder,
`data-testid="photo-drop-placeholder"`, where the photo drop goes) and `closed` (winner, results,
link to `/history`). Not built yet: photo drop, album, rating prompt. The accent (`marquee-glow`,
`text-cinema`) is used only on the winner card; ranked posters on the ballot use a plain
foreground ring and number badge. Server error messages are shown as-is (`ApiErrorNotice`), e.g.
"This phone can't vote as them" or "Voting is not open"; a refused ballot also refetches the
snapshot and the people list, so a stale screen catches up.

**Who-are-you:** a grid of big avatar tiles (emoji + colour + name), not a dropdown. After a ballot
is submitted, the phone shows "Pass to next person", which goes back to the grid.

On `/s/[session]` the voter is one of the people this phone holds (`binding: "mine"` from
`GET /api/v1/people`). One person → straight to the ballot. Several → a "Who's voting?" grid of just
those people (tiles show "Voted" from `GET /sessions/{id}/ballots/mine`), and after Done the
confirmation offers "Pass to next person" back to that grid. Nobody → "Pick who you are" (→ `/who`).
The confirmation lists the ranks as the server saved them; "Change my picks" reopens the ballot
pre-filled (ballots are replaceable until close).

**Ballot:** tap a poster to make it 1, the next tap makes 2, then 3. Tap again to clear. "Done" is
enabled after the first tap (partial ballots are allowed).

The tap-to-rank logic is a pure reducer, `src/lib/ballot.ts` (unit-tested to 100%, gated in
`vitest.config.mts`): picks are kept in rank order, the cap is the snapshot's `ballot_size`
(k = min(3, options − 1), ADR-0006), a tap once full is ignored, and clearing a pick moves the ones
below it up, so the `PUT /sessions/{id}/ballots` ranks always run 1..m with no gaps. Posters come
from TMDB's image CDN (`w342`); typed titles without a poster get a title card
(`src/components/poster.tsx`).

## State management

TanStack Query owns server state, with keys per session snapshot. `useLiveSession(sessionId)` mints
an SSE ticket, opens `EventSource`, invalidates the snapshot on each event, refetches on
`visibilitychange` and on reconnect, and polls every 5s while the stream is down. It exposes
`data-live="ready|reconnecting"` for tests. There is no global client store beyond small UI state.

**Built so far:** `src/hooks/use-live-session.ts` is the polling half only: query key
`["night", id]`, `refetchInterval` 5s (also in a background tab), and a refetch on
`visibilitychange` → visible. With no stream it always reports `live: "reconnecting"`, rendered as
`data-live` on `/s/[session]`'s root (`data-testid="night-screen"`, which also carries
`data-status`). The SSE half (ticket, `EventSource`, invalidate per event, `ready`) drops into the
same hook without changing callers or tests.

## Photo drop

`src/lib/photos/` contains `process.ts` (exifr date read, `createImageBitmap`, lazy `heic-to`
worker, canvas to 2048px JPEG plus a 480px thumbnail), `queue.ts` (IndexedDB queue, at most two
parallel PUTs, retry with backoff, resumes on `visibilitychange`) and `upload.ts` (presign → PUT →
complete). The input is `<input type="file" accept="image/*" multiple>`, with no `capture`
attribute and never `image/heic`. See [ADR-0005](decisions/ADR-0005-photo-pipeline-and-storage.md).

The album is a thumbnail grid with a full-screen viewer, the uploader's avatar, and emoji reactions.
The TV slideshow uses the Screen Wake Lock API where supported.

## API client & types

`src/lib/api.ts` is a fetch wrapper over same-origin `/api/v1` (rewritten to fnh-api) with
`credentials: "include"`. It fetches the double-submit token from `GET /api/v1/csrf` once (one
in-flight promise shared by concurrent calls), sends it as `X-FNH-CSRF` on every mutation, and on a
403 CSRF rejection refreshes it and retries once. Every non-2xx becomes an `ApiError` carrying the
envelope's `code`, `message` and `request_id` plus `retryAfter` (seconds) from `Retry-After`; a
non-envelope body or a transport failure becomes a generic "can't reach Family Night" error.
Screens show `message` as-is, because the server already keeps it generic. One typed function per
endpoint (`api.join`, `api.people`, `api.claimPerson`, ...).

Types are generated from `backend/openapi.json` into `src/types/api.gen.ts`. Don't hand-edit them;
CI fails on drift (FieldPro pattern).

TanStack Query: one `QueryClient` per tab (`src/app/providers.tsx`). Queries don't retry a 4xx, and
mutations never retry.

## Tooling and tests

| Command (in `frontend/`) | What |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7) |
| `npm run lint:install`, then `npm run lint` | ESLint with `eslint-config-next`. ESLint, the Next config and the TypeScript 5 that typescript-eslint needs live in `tools/eslint/` (TypeScript 7 has no JS API for it), and `eslint.config.mjs` resolves its plugins from there. It also bans `waitForTimeout` / `setTimeout` in tests |
| `npm run format:check` | Prettier + `prettier-plugin-tailwindcss` (class order) |
| `npm test` | Vitest with v8 coverage, `src/**/*.test.ts`: API client CSRF and error handling, night-code input, the ballot reducer (100% gate on `src/lib/ballot.ts`) |
| `npm run test:e2e` | Playwright + axe against the real API; see [`07-cicd.md`](07-cicd.md#running-e2e-locally) |

## Where to add new code

New phone screen → `app/(public)/…` plus a hook in `src/hooks/`. New admin table → reuse the
`DataTable` primitive. Never call TMDB or storage from the browser except through presigned URLs.

## What's intentionally **not** here / **not** built yet

- No service-worker offline mode beyond the upload queue. No push notifications.
- No zip download. No light theme toggle (dark only in v1).
- Generator UI, approval/pick-one ballots, and the bulk add for owned titles come in Phase 2.
