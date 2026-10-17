# Owner portal (#44) build split — briefs

Common to all: base branch `claude/owner-portal` (has the spec, `src/lib/portal.ts` + tests, and
`src/components/portal/{portal-nav,inbox,up-next-card,stats}.tsx`). Spec: `docs/architecture/proposals/owner-portal.md`
(approved). Mockup: https://claude.ai/artifact/NvgqHQVAxmJnxz9TCstnH2. Match TanStack Query / components/ui / lucide / api.ts.
Targeted vitest only for files you touch; no full suite, no e2e, no deploys, no credentials. Each opens its own PR
into `main` saying "Part of #44" (only the last-merged, piece A, says "Closes #44"). Don't merge.
Only piece A edits `docs/architecture/04-frontend.md`; only piece B edits `src/lib/portal.ts` (others ask B or
add a sibling file). Only pieces that wait for #40 may touch `src/lib/api.ts`, and only additively.

## A — Shell + nav  (WAITS for #40)
Files: new `src/components/portal/portal-shell.tsx`; `src/app/admin/layout.tsx`, `admin-shell.tsx` (delete/replace),
`admin/page.tsx` (redirect → /host), `admin/admin-error.tsx` ("Go to Home" → /host); new `src/app/host/layout.tsx`;
`src/app/host/page.tsx` drop PhoneScreen wrapper only; `04-frontend.md` route table + Admin section.
Done: §3 (roles, sidebar ≥md, tab bar + More <md, badges from inbox counts via portal.ts helpers, sign-out in
sidebar footer/More), AC-P0.2–0.7. Badge data: reuse queries `["claims"]`, `["admin","pin-resets"]`, `["admin","people"]`.

## B — Home dashboard + attention inbox  (can start now; PIN-reset rows wired after #40)
Files: `src/app/host/host-home.tsx` (replace with dashboard), new `src/app/host/home-dashboard.tsx` if preferred,
`src/components/portal/{up-next-card,inbox,stats}.tsx`, `src/lib/portal.ts` (+test, keep 100%).
Done: §5 P1/P1a/P1b/P2 and §6 data flow; inbox actions wired (claims approve/reject, end night, open, hide-unrated
in localStorage via parseHidden/toggleHidden, see profile → /admin/people#person-{id}); "Also running" list; host
never sends admin queries. After #40: reset/dismiss rows with confirm (guest-flow `copy.admin.resetConfirm`).
AC-P1.*, AC-P2.*, AC-P3.*. Must not touch host layout/page (A).

## C — People  (WAITS for #40)
Files: `src/app/admin/people/*` only (+ `src/lib/admin.ts` helpers/tests if needed).
Done: §5 P3 — "Add a person" as the one primary, PIN-requests section hides when empty, Status column
(PIN set / No PIN yet / Locked from has_pin/locked), filter All · Family · Guests · Needs attention, `id="person-{id}"`
rows with scroll+highlight on hash. AC-P4.1, AC-P4.2.

## D — Settings  (WAITS for #40)
Files: `src/app/admin/settings/*` only; may import UseAsTv logic moved into a new
`src/components/portal/use-as-tv.tsx` (B must then not keep its own copy — B uses `onUseAsTv` prop).
Done: §5 P5 — groups Joining (join link, rotate, #40's QR toggle), Movie nights, Streaming, Your account (#40's
password form), This browser (Use as TV + sign out); sticky sub-nav (chips on phone); per-group Save, only the dirty
group's Save is filled; host sees Account + This browser only and no 403 panel. AC-P5.*. Behaviour of #40's pieces unchanged.

## E — Phones, Library, History, night page  (can start now)
Files: `src/app/admin/devices/*`, `src/app/admin/movies/*`, `src/app/admin/history/*`, `src/app/host/[session]/*`.
Done: §5 P4/P6/P7 — Phones title "Phones and TVs" + lede + empty state, no "device" wording in UI; History
correct-winner hidden for hosts (role from `["me"]`), and History renders for hosts; Library unchanged except copy;
night page gets a "← Home" back link and, on closed nights, a read-only Ratings panel (who rated / not yet) as the
target of the inbox's unrated row. Proxy rating optional.
