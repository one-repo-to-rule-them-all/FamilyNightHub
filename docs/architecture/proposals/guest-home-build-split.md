# Guest home (#58) build split — briefs

Each brief below is self-contained: paste the **Common** block plus one piece into a fresh session.

## Common (applies to every piece)

- **Repo:** `one-repo-to-rule-them-all/FamilyNightHub`. This is Family Night Hub, a household
  movie-night app with a FastAPI backend (`backend/`) and Next.js 16 frontend (`frontend/`), deployed
  on Fly.io staging. Phones join with a night code, pick a person and enter a 6-digit PIN (ADR-0014).
- **Spec (approved by the owner 2026-10-18, the source of truth):**
  `docs/architecture/proposals/guest-home.md`. Read §3 (model and the four "moves by itself" rules),
  §4 (screen rules), your piece's §5 sections, §6 (data flow), §7 (copy: use these strings), and
  §12 (acceptance criteria). It builds on `docs/architecture/proposals/guest-flow.md` (screen ids,
  `data-screen`, the PIN and switch sheets); read its §4 too.
- **Mockup:** https://claude.ai/artifact/NkfKdSr6U1RdH3x7kFW69P (also
  `docs/architecture/proposals/guest-home-mockups.html`). Visual language: the existing dark theme,
  cinema accent, `components/ui` buttons (`default` = the one filled primary, `secondary` for other
  standalone actions, `size="tap"` = 56px).
- **Start:** `git fetch origin && git checkout -B claude/guest-home-<piece> origin/main`. Piece A must
  be merged into `main` before B, C or D start (they import its exports); E can start any time; F
  starts after B, C and D merge.
- **Constraints:** ADR-0014 rules are unchanged: one current person per phone, a PIN on **every**
  switch, a wrong PIN never changes the current person. Copy never says "session", "device",
  "binding" or "profile". Match the existing code: TanStack Query, `components/ui`, lucide icons,
  `src/lib/api.ts`, `PhoneScreen`. Every screen root gets its `data-screen`; exactly one
  `data-testid="primary-action"` per the spec.
- **File ownership is strict.** Touch only the files your piece lists. Need a change in another
  piece's file? Ask that piece (or the coordinating session) instead of editing it. Only A edits
  `src/lib/home.ts`, `src/lib/auto-move.ts`, `src/hooks/use-phone.ts` and
  `docs/architecture/04-frontend.md`. Only E touches `src/lib/api.ts` (additively) and the backend.
- **Tests:** targeted Vitest only for files you touch, from `frontend/`:
  `npx vitest run <paths>`. Also `npm run typecheck` and `npm run lint`. Backend (E only), from
  `backend/`: `uv run pytest <paths>`. **Never** run the full suite or Playwright; no deploys; never
  enter credentials anywhere.
- **PR:** one PR into `main` per piece, titled `feat(guest-home): <piece name> (#58)`, body says
  "Part of #58" and lists the ACs covered. Piece F's PR says "Closes #58". Don't merge.

---

## A — Shell, live hand-off and auto-move  (FIRST)

**Why first:** B, C and D build on these exports. Keep it small and merge-ready fast.

**Files (only these):**
- new `frontend/src/lib/home.ts` + `home.test.ts` (100% branch coverage, like `src/lib/portal.ts`)
- new `frontend/src/lib/auto-move.ts` + `auto-move.test.ts` (100% branches)
- new `frontend/src/hooks/use-household-night.ts`
- new `frontend/src/hooks/use-auto-move-countdown.ts`
- new `frontend/src/components/home/{app-bar,bottom-nav,live-handoff,guest-shell}.tsx` (+ tests)
- `frontend/src/hooks/use-phone.ts` (export what the shell needs; keep current exports working)
- `frontend/src/hooks/use-photo-uploads.ts` (the upload hold only: hold `auto-move` while any job is
  `processing|queued|uploading|waiting`, release when none is)
- `docs/architecture/04-frontend.md` (route table + a "Phone home" section pointing at the spec)

**Exports (other pieces rely on these names and shapes; keep them):**
- `home.ts`:
  - `type TonightState = "T0" | … | "T7"` and
    `tonightState(input: { night?: Pick<Night,"id"|"status">; myBallots?: OwnBallot[]; people: PersonTile[]; rateOwed?: { sessionId: string } | null }) → { state, primary: { label, href } | { label, action: "switch" } | null }`
    (spec §5 H1 table).
  - `isNewNight(seenId: string | null, liveId: string | undefined): boolean`, plus
    `readSeenNight()` / `writeSeenNight(id)` on `sessionStorage["fnh.seenNight"]` (try/catch).
  - `arrivalTarget(liveNight?: {id}): string`: `/s/{id}` or `/` (spec §3.3 rule 1).
  - `coldOpenTarget(input: { firstMount: boolean; night?: {id,status}; votedByCurrent: boolean }): string | null`:
    `/s/{id}` only when `firstMount && status === "voting" && !votedByCurrent` (§3.3 rule 2).
  - `pastNightKind(nightId: string, latestId: string | undefined): "wrap" | "recap"`.
  - `readStayNight()` / `writeStayNight(id)` on `sessionStorage["fnh.stayNight"]` (try/catch).
- `auto-move.ts`: `holdAutoMove(): () => void`, `useAutoMoveHeld(): boolean`
  (`useSyncExternalStore`), `AUTO_MOVE_SECONDS = 60`, and the pure reducer
  `nextCountdown(state: { seconds: number; paused: boolean }, input: { held: boolean; tick: boolean }) → state`.
- `useHouseholdNight() → { night?: NightSummary; isNew: boolean; markSeen(): void }`: the live-night
  query moved into the shell (5 s poll while visible, refetch on focus, `refetchIntervalInBackground: false`).
- `useAutoMoveCountdown(nightId: string | undefined, enabled: boolean) → { seconds: number; paused: boolean; stay(): void; stayed: boolean }`:
  ticks once a second; paused while `useAutoMoveHeld()`, while `document.querySelector("dialog[open]")`
  is non-null (check each tick), or while `document.visibilityState === "hidden"`; at 0 it calls
  `router.push("/s/{nightId}")` and `writeSeenNight`; restarts at 60 if `nightId` changes; `stay()`
  writes `fnh.stayNight` and stops it.
- `<GuestShell back?: {href,label} hideNav?: boolean handoff?: "plain" | "countdown" | "none" screen: string>`:
  the app bar (household name from `fnh.lastJoin`, else "Family Night"; the current person's avatar
  button opens the existing `SwitchSheet`), the bottom nav (Home `/`, History `/history`, Me `/me`,
  `aria-current`, the live dot with `aria-label="Movie night is on"`, 56px + safe-area), and the
  `LiveHandoff` at the top of the content when a night is live and it isn't this screen's own night.
- `<LiveHandoff night countdown?: boolean primary?: boolean>`: spec §5 H0 and H0c; `data-testid`s
  `live-handoff`, `handoff-countdown` (with `data-seconds`), `handoff-stay`; copy
  `copy.h.handoff.*`; announces at 60/30/10 s and on pause through a visually hidden polite live
  region.

**Done:** spec §5 H0 + H0c, §6 auto-move hold, AC-H0.1/0.4 and AC-H3.5/3.8–3.10 at the unit level
(Vitest with fake timers: start at 60, tick, pause on hold, pause on an open `<dialog>`, pause when
hidden, resume, move at 0, Stay here, night change restarts).

---

## B — Home  (after A merges)

**Files (only these):**
- `frontend/src/app/home-resolver.tsx`: becomes Home. Keep the S0/S1 landing for no device and the
  `/who` redirect for no current person exactly as they are.
- new `frontend/src/components/home/{tonight-card,recent-nights,photo-strip}.tsx` (+ tests)
- `frontend/src/components/night/rate-prompt-card.tsx`: add a `variant` prop so Home can render its
  button as `secondary`.
- One navigation line each in `frontend/src/app/(public)/who/who-grid.tsx`,
  `frontend/src/app/(public)/j/[slug]/join-form.tsx` and
  `frontend/src/components/night/switch-sheet.tsx`: where they go to `/` after a join, a right/new
  PIN or a switch, go to `/?arrive=1` instead. Nothing else in those files.

**Done:**
- Spec §5 H1: greeting, Tonight card T0–T7 from `tonightState()` with exactly one primary
  (T0 and T4: zero plus `data-testid="waiting"`), `RatePromptCard` only when the card isn't asking,
  *My recent nights* (3 newest from `GET /people/{me}/profile`), family photo strip.
- "Just started" chip, `navigator.vibrate(40)` (guarded), polite announcement when `isNewNight`.
- §3.3 rule 1: `?arrive=1` + live night → `router.replace(arrivalTarget(night))`; otherwise strip the
  parameter.
- §3.3 rule 2 (owner decision): a module-level `firstMount` flag in the Home component; on the first
  mount, `coldOpenTarget()` → `router.replace` straight to the ballot when voting is open and the
  current person has no ballot (`GET /sessions/{id}/ballots/mine`). Later mounts (nav taps, back) never
  redirect.
- §3.3 rule 4: Home never redirects after its first mount; the card updates in place.
- Render inside `GuestShell` with `handoff="none"`.
- ACs: AC-H1.1–1.7, AC-H2.1–2.6.

---

## C — Night screens and past nights  (after A merges)

**Files (only these):** `frontend/src/app/(public)/s/[session]/*` (night-screen, voting-flow,
winner, page) and `frontend/src/app/(public)/albums/[session]/*`.

**Done:**
- The `closed` branch splits with `pastNightKind(id, latestId)` (`latestId` from
  `GET /sessions?status=draft&status=voting&status=revealed&status=tonight&status=closed&limit=1`,
  30 s refresh and on focus):
  - **H3w That's a wrap** (`data-screen="wrap"`): hand-off with the countdown when a newer night is
    live (`GuestShell handoff="countdown"`). Primary is the hand-off's Go, else the star row while
    unrated, else **Back to Home**. Then the winner, rating, results, album with a `secondary`
    **Add photos**. Remove **Past movie nights** and the `CurrentChip`.
  - **H3r Night recap** (`data-screen="recap"`): Your night (picks with the winner marked, editable
    stars), the family's picks, Who came (`api.present`), the album and **See all photos**. No
    primary except the hand-off, which carries the countdown (`handoff="countdown"`).
- Owner decision (spec §11.2, H0c): on wrap and recap the phone auto-moves to the new night after
  60 s unless **Stay here** is tapped. The countdown pauses during a photo upload, while any dialog
  is open, or while the page is hidden; all of that is A's `useAutoMoveCountdown`, so only wire it.
- S9, S11, S12, S13 inside `GuestShell` (nav + Home live dot, `handoff="none"`). `CurrentChip` only on
  S10/S11.
- S10 ballot: `hideNav`, a **‹ Home** link in the header, unsaved picks kept in `sessionStorage`
  keyed by night + person and restored on return.
- H6 album inside `GuestShell` with ‹ back to `/s/{id}`.
- ACs: AC-H0.2, AC-H3.1–3.3, AC-H3.5–3.10 (screen level), AC-H3.11 for album.

---

## D — History, Me and profile  (after A merges)

**Files (only these):** `frontend/src/app/(public)/history/*`, `frontend/src/app/(public)/me/*`,
`frontend/src/app/(public)/people/[id]/*`.

**Done:**
- **H2 History** (`data-screen="history"`, `data-tab`): tabs Mine (default) and Family, the tab in
  `?tab=`. Mine comes from `GET /people/{me}/profile` (`nights`, `stats`): picks in rank order (or
  "You liked N" for approval), 🏆 Your pick won, You rated ★n or a `secondary` Rate it
  (→ `/s/{id}#rate`), 📷 count. Family is the existing list. Rows link to `/s/{id}`. Empty states as
  in the copy deck.
- **H4 Me** (`data-screen="me"`): avatar header, **Change my name** (once, while `can_rename`, as
  built), stats + See my nights, *This phone* (**Switch person** opens the existing `SwitchSheet`,
  Add someone → `/who`, "Also on this phone"), **Change my PIN** (as built), the host sign-in link.
  **Change picture** (owner decision: any number of times) renders only when `api.updateSelf`
  exists, i.e. after piece E merges. If E isn't merged when you finish, leave a `TODO(#58 G10)` and
  hide the button.
- **H5 profile** inside `GuestShell` with ‹ back; your own id → `router.replace("/me")`.
- All three use `GuestShell handoff="plain"` (no countdown on these screens).
- ACs: AC-H3.4 and AC-H3.11 for these screens, AC-H4.1–4.3, AC-H5.1, 5.2, 5.4 (5.3/5.5 once E is in).

---

## E — Backend G10: change your picture anytime  (any time, parallel)

**Files (only these):** `backend/app/api/v1/people.py`, `backend/app/services/people_service.py`,
`backend/app/schemas/identity.py`, their tests under `backend/tests/`, `backend/openapi.json`,
`frontend/src/types/api.gen.ts` (regenerated, never hand-edited), and an additive
`api.updateSelf(personId, body)` in `frontend/src/lib/api.ts`.

**Done:**
- `PATCH /devices/me/people/{id}` accepts optional `name`, `avatar_emoji` and `color`; at least one
  is required (422 otherwise). The current person only (403 otherwise, as today).
- **Picture changes are unlimited** (owner decision). The rename-once rule and its counter apply
  only when `name` is present and different. A request with only `avatar_emoji`/`color` never
  returns 409 for "already renamed".
- Validate like self-create: emoji from the allowed set / a single emoji grapheme, colour from the
  avatar palette (422 otherwise). Audit `person.avatar_changed`.
- Keep the existing `api.renameSelf` working.
- Regenerate types: `(cd backend && uv run python scripts/dump_openapi.py openapi.json)` then
  `(cd frontend/tools/openapi && npm ci) && (cd frontend && npm run gen:api)`.
- Route tests: picture change ×3 succeeds; a picture change after a rename succeeds; a rename after a
  picture change still counts as the first rename; 403 for a non-current person; 422 for a bad emoji,
  a bad colour or an empty body.
- Spec §8 G10; AC-H5.3, AC-H5.5 (API level).

---

## F — e2e  (after B, C, D merge; E optional)

**Files (only these):** new `frontend/e2e/guest-home.spec.ts`. Re-check `frontend/e2e/*.spec.ts` for
anything asserting the old behaviour (`no-night`, `/` redirecting to the night on a non-voting cold
open); there was none on 2026-10-18. Fix such assertions only if they exist, and list them in the PR.

**Done:** spec §12 as Playwright at 360×640. Use the existing fixtures in `frontend/e2e/support` and
`seed_night.py`. Use `page.clock` for every countdown AC so nothing waits 60 real seconds. Write the
spec but **do not run it**: CI is disabled and the owner's sign-off pass runs e2e. Run
`npm run typecheck` and `npm run lint` only. The PR says "Closes #58".
