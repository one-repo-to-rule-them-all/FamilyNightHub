# Guest home (#58) build split — briefs

Common to all: base branch `main` **after the e2e sign-off PR merges** (it edits `(public)/who` and
`frontend/e2e`). Spec: `docs/architecture/proposals/guest-home.md`. Mockup: https://claude.ai/artifact/NkfKdSr6U1RdH3x7kFW69P.
Match TanStack Query / `components/ui` / lucide / `api.ts` / `PhoneScreen`. ADR-0014 rules unchanged
(PIN on every switch; a wrong PIN never changes the current person). Targeted Vitest only for files
you touch; no full suite, no e2e runs, no deploys, no credentials. Each piece opens its own PR into
`main` saying "Part of #58" (the last to merge says "Closes #58"). Don't merge.
Only piece A edits `src/lib/home.ts`, `src/hooks/use-phone.ts` and `docs/architecture/04-frontend.md`
(others ask A or add a sibling file). Only piece E touches `src/lib/api.ts`, and only additively.

## A — Shell + live hand-off  (FIRST; B–D start once it merges)
Files: new `src/lib/home.ts` (+`home.test.ts`, 100% branches), new `src/hooks/use-household-night.ts`,
new `src/components/home/{app-bar,bottom-nav,live-handoff,guest-shell}.tsx`, `src/hooks/use-phone.ts`
(export the live-night query for the shell), `04-frontend.md` (route table + "Phone home" section).
Done: `tonightState(night, ballots, people, ratings) → T0…T7 + primary {label, href|action}`,
`isNewNight(seenId, liveId)`, `fnh.seenNight` read/write (try/catch), `arrivalTarget(liveNight)`,
`pastNightKind(nightId, latestId) → "wrap" | "recap"`; `useHouseholdNight()` → `{night, isNew, markSeen}`
(5 s visible-only poll, focus, wake); `GuestShell` = app bar (household name fallback "Family Night",
person button → existing `SwitchSheet`) + bottom nav (Home/History/Me, live dot, `aria-current`,
56px + safe area, `hideNav` prop) + `LiveHandoff` (spec H0h, `data-testid="live-handoff"`,
`primary` prop). AC-H0.1, AC-H0.4 (unit-level).

## B — Home  (after A)
Files: `src/app/home-resolver.tsx` (→ Home; keep S0/S1 landing and the `/who` redirect),
new `src/components/home/{tonight-card,recent-nights,photo-strip}.tsx`,
`src/components/night/rate-prompt-card.tsx` (a `variant` prop for `secondary`),
and the `?arrive=1` navigation line only in `src/app/(public)/who/who-grid.tsx`,
`src/app/(public)/j/[slug]/join-form.tsx` and `src/components/night/switch-sheet.tsx`.
Done: spec H1, T0–T7 with exactly one primary, "Just started" chip + vibrate + aria-live, §3.3
(`arrive=1` jumps to the live night, else strips it). AC-H1.*, AC-H2.*.

## C — Night screens + past nights  (after A)
Files: `src/app/(public)/s/[session]/*`, `src/app/(public)/albums/[session]/*`.
Done: `closed` splits into H3w (latest night: hand-off primary / stars / Back to Home) and H3r (older:
Your night, family picks, Who came via `api.present`, album link; no primary without a live night);
S9/S11–S13 inside `GuestShell`; S10 without nav, "‹ Home" in the header, unsaved picks kept in
`sessionStorage` per night+person; `CurrentChip` only on S10/S11; album in the shell with ‹ back.
AC-H3.*.

## D — History + Me + profile  (after A)
Files: `src/app/(public)/history/*`, `src/app/(public)/me/*`, `src/app/(public)/people/[id]/*`.
Done: H2 tabs Mine (profile nights: picks, Your pick won, You rated / Rate it, photos; stats summary)
and Family (existing list, `?tab=` in URL); H4 Me (header, rename once, stats + See my nights,
This phone: Switch person → SwitchSheet, Add someone → /who, Change my PIN; **Change picture** rendered
only when `api.updateSelf` exists — i.e. after E); H5 profile in the shell, own id → `/me`.
AC-H4.*, AC-H5.1, .2, .4.

## E — Backend G10, self picture change  (parallel with A–D, optional)
Files: `backend/app/api/v1/people.py`, `backend/app/services/people_service.py`,
`backend/app/schemas/identity.py`, their tests, regenerated OpenAPI types, additive
`api.updateSelf(personId, {name?, avatar_emoji?, color?})` in `src/lib/api.ts`.
Done: `PATCH /devices/me/people/{id}` accepts optional `avatar_emoji`/`color` (≥ 1 field), current
person only; rename-once counter moves only on `name`; audit `person.avatar_changed`; route tests for
403 (not current), 422 (bad emoji/colour), and rename-once unaffected by a picture change. AC-H5.3.

## F — e2e  (last, after B–D)
Files: new `frontend/e2e/guest-home.spec.ts`; re-check any spec asserting `no-night` (none on
2026-10-18). Write §12 as Playwright; not run in CI (disabled) — the owner's sign-off pass runs it.
