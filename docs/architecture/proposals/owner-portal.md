# Proposal: the owner portal (one place to run nights and look after the family)

**Status:** Approved by the owner from the mockups (2026-10-17). Build in progress (split across sessions, see §9).
**Issue:** #44. Rolls up into #42 (staging deploy and owner sign-off).
**Builds on:** [ADR-0002](../decisions/ADR-0002-device-identity-and-join-flow.md) (accounts, claims,
"Use as TV"), [ADR-0008](../decisions/ADR-0008-ctrl-alt-defeat-design-tokens.md) (tokens, one
accent), ADR-0014 (passwords, person PINs, admin-only PIN resets; PR #43, frontend in #40) and
[`guest-flow.md`](guest-flow.md), whose structure and screen rules this proposal follows.
**Mockups:** [`owner-portal-mockups.html`](owner-portal-mockups.html) (clickable: dashboard, inbox, people,
settings; desktop and 360 px; admin and host; also published as an Artifact linked from the PR).

---

## 1. Executive summary

The owner said the portal "feels clunky and isn't helping". The code survey agrees, and the reason
is structural: the owner's tools are spread over **two apps** (`/host` to run a night, `/admin` for
the household), joined by one link each way, and **neither one has a front page**. `/admin`
redirects to People; `/host` is a single column where *Start a night* sits at the same weight as
*Sign out*. Everything that needs the owner (a phone waiting for approval, a kid locked out of their
PIN, a night nobody rated) lives on its own page, so the owner only finds it by going looking.

This proposal makes it **one portal with a home screen that answers two questions**:

1. **What's next?** One "Up next" card that always holds exactly one primary action: *Start
   tonight's movie night*, *Finish the shortlist*, *Close voting*, *End the night*, depending on
   where the household's night is.
2. **What needs me?** An **attention inbox** that collects every pending decision in one list, each
   row with its own inline action: phone claims (host and admin), PIN reset requests and locked
   profiles (admin only, ADR-0014), nights still missing ratings, and nights left open.

Underneath: a few **quick stats** (last night's winner and rating, nights this month, the turnout
trend). Around it: one **navigation** shell, a sidebar on desktop and bottom tabs on a phone, whose
items depend on the role. **Settings** is split into named groups with a sub-nav instead of one
400-line page.

URLs stay where they are (`/host`, `/host/[session]`, `/admin/*`), so bookmarks, the proxy rules,
the login redirect and #40's routes all keep working. What changes is the shell around them and the
home screen.

The dashboard can be built entirely on **existing endpoints** (§8). One small backend addition,
`photo_count` on the night summary, is needed for the photos stat and is flagged as gap **O1**; the
dashboard hides that stat until it ships. A direct admin PIN reset (gap **O2**) would let the inbox
clear a locked profile that never asked for help; until it exists, that row explains what to do.

---

## 2. Findings (code survey, 2026-10-17)

| # | Where | What the owner meets | Why it hurts |
|---|---|---|---|
| F1 | `admin/page.tsx` | `/admin` → redirect to `/admin/people` | No overview; the first thing an admin sees is a table. |
| F2 | `host-home.tsx`, `admin-shell.tsx` | Two shells: `/host` is a 448 px phone column with an "Admin: people, devices, settings" row; `/admin` is a 5xl page with a "Back to host" link | Two mental models and two navigations for one person. The owner bounces between them. |
| F3 | `host-home.tsx` | Start night → Nights in progress → Waiting for approval → The living-room TV → Admin link → Sign out, all `text-xl` sections | No hierarchy. The main job competes with housekeeping, and the start form is shown even while a night is already running. |
| F4 | `host-home.tsx` | "Waiting for approval" is an always-visible section ("No phones are waiting.") | Empty housekeeping takes space every visit; when a claim does arrive, nothing outside that section says so. |
| F5 | ADR-0014 / #40 | PIN reset requests and locked profiles land on `/admin/people#pin-requests` | Another page to visit. A kid stuck at S6 ("Asked the family admin") waits until the owner happens to open People. |
| F6 | `settings-admin.tsx` | Join link, Defaults, Streaming services stacked on one page (404 lines); #40 adds the QR toggle and ADR-0014 adds password change somewhere | No grouping and no place for account settings. |
| F7 | everywhere | No stats | "How did last Friday go?" needs a trip to `/history`. Participation, ratings, photos are invisible. |
| F8 | `UseAsTv` | "Use this browser as the TV" is a full section on every visit | It's a once-per-TV action presented as a daily one. |
| F9 | admin screens | A host who opens an admin link gets an "Admins only" panel | The nav shows links the account can't use. |

What already works and must be kept: the NightCodeCard (code shown once, ADR-0002), the
`/host/[session]` builder and voting panel, the `DataTable` admin lists, `ModalDialog` confirmations,
`AdminQueryError` for direct-URL 403s, and the 10 s claims poll.

---

## 3. Information architecture

### 3.1 One portal, two roles

The portal is every route under `/host` and `/admin`, rendered inside one `PortalShell`
(`src/components/portal/portal-shell.tsx`). The shell reads `GET /auth/me` once and filters the nav
by `role`.

| Nav item | Route | Icon (lucide) | Admin | Host | Badge |
|---|---|---|---|---|---|
| **Home** | `/host` | `House` | ✓ | ✓ | open inbox count |
| **People** | `/admin/people` | `Users` | ✓ | — | PIN requests + locked |
| **Phones** | `/admin/devices` | `Smartphone` | ✓ | — | — |
| **Library** | `/admin/movies` | `Clapperboard` | ✓ | — | — |
| **History** | `/admin/history` | `History` | ✓ | ✓ (read-only) | — |
| **Settings** | `/admin/settings` | `Settings` | ✓ (all groups) | ✓ (Account + This browser only) | — |

- A night being run (`/host/[session]`) is not a nav item. It is reached from the Up-next card and
  the inbox, and shows a back link "Home" plus the night title as its header. Home is marked
  `aria-current` while on a night.
- **Devices is renamed "Phones"** in the UI (copy rule from guest-flow §7: "device" never appears).
  TVs are listed there too, with a TV badge, as today.
- **Hosts** see Home, History and Settings. History is the same table without **Correct winner**
  (that's `admin:history`). Settings shows only the groups that don't need `admin:settings`. A host
  who types an admin URL still gets the existing "Admins only" panel; its link changes to "Go to
  Home".
- The role gate in the shell is UX only. The API stays the boundary (unchanged).

### 3.2 Shell layout

- **Desktop (≥ 1024 px):** a 240 px left sidebar: household name and "Family Night" wordmark at the
  top; the nav; at the bottom the signed-in name, role, and a **Sign out** ghost button. Content is
  `max-w-5xl`, left-aligned against the sidebar.
- **Tablet (768–1023 px):** the sidebar collapses to a 72 px icon rail with labels under the icons.
- **Phone (< 768 px):** a top bar (household name, account menu) and a fixed **bottom tab bar** with
  at most five items: Home, People, Library, History, **More**. More opens a bottom sheet with
  Phones, Settings, Sign out. A host's tab bar is Home, History, More (Settings, Sign out). Tabs are
  56 px tall and respect `env(safe-area-inset-bottom)`. Content gets bottom padding so the last row
  isn't under the bar.
- The badge is a small pill with the count (`aria-label="3 things need you"`), `bg-cinema` only
  when a PIN request or a phone claim is waiting (someone is standing there waiting), otherwise
  neutral.

### 3.3 What moves where

| Today | Portal |
|---|---|
| `/host` start form, nights in progress | Home → Up-next card (+ "Also running" list when >1) |
| `/host` "Waiting for approval" | Home → inbox rows (claims) |
| `/admin/people#pin-requests` (#40) | Stays (full list), **and** Home → inbox rows; People badge |
| `/host` "Use this browser as the TV" | Settings → **This browser**; also a secondary link on the Up-next card while a night is in draft/voting |
| `/host` "Admin: …" link, `/admin` "Back to host" | Gone: the nav replaces both |
| `/host` Sign out | Sidebar footer / More sheet |
| `/admin` → redirect to People | `/admin` → redirect to `/host` (Home) |
| `/admin/settings` single page | Settings with groups (§5.5) |

---

## 4. Screen rules (apply to every portal screen)

Same rules as guest-flow §4, adapted for a denser, account-holder screen:

1. **Exactly one primary action per screen**, the only filled cinema button, marked
   `data-testid="primary-action"`. On Home it lives on the Up-next card. Inbox rows have
   **row-level** actions styled `secondary` (never the cinema fill), so they never compete with the
   page's primary. List pages (People, Library) have their "Add" as the primary.
2. Every screen root carries `data-screen="portal-<id>"`.
3. **No dead ends:** every empty state says what will fill it and, if the owner can do something,
   offers it.
4. **Nothing silently stale:** inbox data polls every 10 s while the tab is visible (today's claims
   cadence), and refetches on focus. A row that disappears because someone else resolved it fades
   out; an action on an already-resolved row refetches and shows `copy.inbox.alreadyDone`.
5. **Enabled must look enabled** (guest-flow rule 9): standalone secondary actions are `secondary`,
   not `outline`.
6. **Destructive or irreversible actions confirm** with `ModalDialog`, as today (revoke, rotate,
   merge, reset PIN, end the night).
7. **Desktop density, phone reach:** admin controls use `sm`/`lg` sizes on desktop; on a phone
   every button in the inbox and Up-next card is ≥ 48 px (`size="lg"`), and the Up-next primary is
   `size="tap"` (56 px).

---

## 5. Screen-by-screen spec

Copy ids refer to §7.

### P1 — Home (`/host`, `data-screen="portal-home"`)

Order, top to bottom (desktop: Up next and Inbox side by side at ≥ 1280 px, 3:2; stacked below):

1. **Greeting line** `copy.home.greeting` ("Good evening, Rodolfo") with the household name muted.
2. **Up-next card** (`data-testid="up-next"`), §5 P1a.
3. **Needs you** inbox (`data-testid="inbox"`), §5 P2. It is never hidden: when empty it collapses
   to one line, `copy.inbox.empty` with a check icon, so the owner learns the absence
   is real.
4. **At a glance** stats (`data-testid="stats"`), §5 P1b.
5. **Also running** (only when more than one active night): compact rows linking to each.

#### P1a — Up-next card: one state, one primary

The card follows the newest night in `draft | voting | revealed | tonight`
(`GET /sessions?status=…&limit=…`), plus the snapshot of that night (`GET /sessions/{id}`) for the
shortlist size and `GET /sessions/{id}/voters` for turnout.

| State | Headline | Fact line | Primary (`primary-action`) | Secondary |
|---|---|---|---|---|
| U0 no night | `copy.up.none.title` | last night's date, or `copy.up.none.first` | **Start movie night** (opens the inline name field + the same button, then creates) | — |
| U1 just created | `copy.up.created.title` | NightCodeCard (code shown once) | **Build the shortlist** → `/host/{id}` | `copy.up.useTv` |
| U2 draft, < 2 titles | `copy.up.draft.title` | `copy.up.draft.fewer` | **Finish the shortlist** → `/host/{id}` | `copy.up.useTv` |
| U3 draft, ≥ 2 titles | `copy.up.draft.title` | `copy.up.draft.ready` ("4 titles · Top 3 voting") | **Open voting** → `/host/{id}` (lands on the builder with the button in view) | `copy.up.useTv` |
| U4 voting | `copy.up.voting.title` | "5 of 7 have voted" + avatars | **See votes** → `/host/{id}` | — |
| U5 revealed / tonight | winner title + poster | `copy.up.tonight.fact` ("Picked by 6 · photos open") | **End the night** → confirm → `POST /close` | **Open the night** link |

- The card never shows a start form while a night is active (fixes F3). Starting a second night
  while one runs is still possible from the night's own page ("End it and start another"), not from
  Home.
- **Use as TV** keeps its confirm and its behaviour (signs this browser out, then `/tv/{id}`).
- A night that has been active for more than 18 h also produces an inbox row (P2, `stale-night`), so
  a forgotten Friday night doesn't sit there until next week.

#### P1b — At a glance

Up to four tiles in a row (2×2 on a phone). Each is a link.

| Tile | Source | Shows | Empty |
|---|---|---|---|
| **Last night** | newest `revealed/tonight/closed` from `GET /sessions?limit=8` | winner poster thumb, title, date, ★ average (`rating.average`, "from N") | `copy.stats.noNights` |
| **This month** | same list, `created_at` in the current month | "3 nights" | "0 nights" |
| **Turnout** | the same 8 nights' `turnout` | the latest number + an 8-bar mini chart (oldest → newest), `aria-label` reads the numbers | hidden with < 2 nights |
| **Photos** | gap O1: `photo_count` on each summary | "42 photos from the last 4 nights" | hidden until O1 ships |

No new endpoint for the first three. Quiet styling: neutral bars (`bg-foreground/30`, the latest
`bg-foreground/70`); the cinema accent stays reserved for the primary and winners.

### P2 — Attention inbox (`data-testid="inbox"`, on Home)

One list, newest first within priority, priority order below. Each row: avatar (or icon), one
sentence in bold-name style, a muted time ("2 min ago"), and its inline actions. Each row root has
`data-inbox-kind="<kind>"` and `data-inbox-id`.

| Priority | Kind | Who sees it | Source | Row text | Actions |
|---|---|---|---|---|---|
| 1 | `pin-reset` | admin | `GET /admin/people/pin-resets` (open) | `copy.inbox.reset` (+ "Locked" chip if `person_locked`) | **Reset PIN** (confirm `copy.admin.resetConfirm` from guest-flow) · **Dismiss** |
| 2 | `claim` | host, admin | `GET /devices/claims` | `copy.inbox.claim` | **Approve** · **Reject** |
| 3 | `locked` | admin | `GET /admin/people` where `locked` and no open reset request | `copy.inbox.locked` | **See profile** (→ `/admin/people#person-{id}`); with gap O2: **Reset PIN** |
| 4 | `stale-night` | host, admin | active night with `created_at` > 18 h ago | `copy.inbox.stale` | **End the night** (confirm) · **Open** |
| 5 | `unrated` | host, admin | `closed` nights in the last 14 days with `rating.count < turnout` | `copy.inbox.unrated` ("2 of 5 rated *Moana*") | **Open** (→ `/host/{id}`) |

- The list shows the first **5** rows and a "Show all (8)" toggle.
- Hosts never see `pin-reset` or `locked` rows (owner decision, ADR-0014), and the admin-only
  queries are not even sent for a host.
- `unrated` is informational, not a nag: it can be **Hidden** per night (row overflow menu,
  `localStorage` `fnh.portal.hiddenUnrated`), the only kind that can be.
- Resolving a row removes it optimistically and invalidates `["portal","inbox"]` plus the source
  query (`["claims"]`, `["admin","pin-resets"]`, `["admin","people"]`).
- Pure logic (merge, priority, stale/unrated thresholds, count) lives in `src/lib/portal.ts`, 100%
  unit-gated like `admin.ts`.

### P3 — People (`/admin/people`, `data-screen="portal-people"`)

Keeps #40's table and PIN-requests section; the redesign changes only the frame and adds status:

- Header: "People" + **Add a person** as the screen's primary.
- **PIN requests** section stays at the top (#40). When empty it shows one muted line saying where a
  request would come from (amended 2026-10-17, #42: a collapsed section left the owner unsure
  whether PIN requests existed at all).
- Under the filter row, a muted line names who "Needs attention" counts and why (`No PIN yet`
  people are never an inbox row: they pick a PIN on their phone, so there is nothing to approve).
- The table gains a **Status** column from ADR-0014's `has_pin` / `locked`: `PIN set`, `No PIN yet`
  (muted), `Locked` (chip). A filter row: All · Family · Guests · Needs attention.
- Each row gets `id="person-{id}"` so inbox links scroll to it.
- Empty state `copy.people.empty`.

### P4 — Phones (`/admin/devices`, `data-screen="portal-phones"`)

Unchanged table. Title "Phones and TVs". No primary (nothing to add here: phones join with the
night code), stated as the lede `copy.phones.lede`. Empty state `copy.phones.empty`.

### P5 — Settings (`/admin/settings`, `data-screen="portal-settings"`)

One route, grouped sections with a sticky sub-nav (desktop: a left list inside the content; phone:
a horizontal chip row at the top). Each group is its own `<section id>` with its own Save, so a save
never mixes groups.

| Group (`id`) | Contents | Role |
|---|---|---|
| **Joining** (`joining`) | Join link + Rotate (today), **Include tonight's code in the TV QR** (#40's toggle, moved here as-is) | admin |
| **Movie nights** (`nights`) | Default voting method, default age cap | admin |
| **Streaming** (`streaming`) | Region, streaming services | admin |
| **Your account** (`account`) | Name, username, email (read-only), **Set/Change password** (ADR-0014 `POST /auth/password`; "Set a password" when `has_password` is false) | admin, host |
| **This browser** (`browser`) | **Use this browser as the TV** (moved from Home), Sign out | admin, host |

- The page has **no** page-level primary: each group's Save is the primary *of that group*, but
  only one Save is enabled (filled) at a time: the group with unsaved changes. Others render as
  `secondary` and disabled. That keeps rule 1 true on screen.
- #40 owns the QR toggle and the password form. This redesign only moves them into the groups; it
  must not change their behaviour.
- A host sees only Your account and This browser, with no sub-nav (two groups).

### P6 — Run a night (`/host/[session]`)

Unchanged content, now inside the shell with a "← Home" back link. One addition for the `unrated`
row to point at: on a `closed` night, a **Ratings** panel listing the night's people with their
star rating (or "not yet"), so the owner sees who's missing. Proxy rating there
(`PUT /sessions/{id}/ratings/proxy`, already in the API) is **optional for this issue**; if left
out, the row's action is "Open" and the panel is read-only.

### P7 — History, Library

Unchanged tables inside the shell. History for hosts hides the Correct-winner column.

---

## 6. Data flow

Home issues, in parallel, with TanStack Query (keys under `["portal", …]` only where the data is
portal-specific; existing keys are reused so other screens stay in sync):

| Query | Key | Who | Poll |
|---|---|---|---|
| `GET /auth/me` | `["me"]` | all | — |
| `GET /sessions?status=draft&…&tonight` | `["nights","active"]` | all | 10 s while visible |
| `GET /sessions?limit=8` | `["nights","recent"]` | all | — |
| `GET /sessions/{id}` (up-next night only) | `["night", id]` | all | live via existing `useLiveSession` |
| `GET /devices/claims` | `["claims"]` | all | 10 s |
| `GET /admin/people/pin-resets` | `["admin","pin-resets"]` (#40's key) | admin | 10 s |
| `GET /admin/people` | `["admin","people"]` | admin | — (refetch on focus) |

Seven requests on first paint for an admin, all small. The inbox renders as soon as its sources
resolve; each source failing shows one muted line in the inbox ("Couldn't load phone requests"),
never a full-page error.

The shell's badge reuses the same queries (no extra requests).

---

## 7. Copy deck

Rules: second person, short, no "device"/"binding"/"session" in the UI, names in **bold**.

| Id | Text |
|---|---|
| `copy.home.greeting` | Good {morning/afternoon/evening}, **{first name}** |
| `copy.up.none.title` | No movie night yet |
| `copy.up.none.first` | Start the family's first one. |
| `copy.up.none.fact` | Last one: **{title}** on {weekday} |
| `copy.up.none.button` | Start movie night |
| `copy.up.none.nameLabel` | Name it (optional) |
| `copy.up.created.title` | Movie night is on. Here's the code. |
| `copy.up.draft.title` | Tonight's shortlist |
| `copy.up.draft.fewer` | Add at least 2 titles before voting. |
| `copy.up.draft.ready` | {n} titles · {method} voting |
| `copy.up.draft.button` | Finish the shortlist / Open voting |
| `copy.up.voting.title` | Voting is open |
| `copy.up.voting.fact` | **{n} of {m}** have voted |
| `copy.up.voting.button` | See votes |
| `copy.up.tonight.fact` | Picked by {n} · photos are open |
| `copy.up.tonight.button` | End the night |
| `copy.up.endConfirm` | End the night? Phones stop joining with tonight's code. Photos and ratings stay open. |
| `copy.up.useTv` | Show it on this TV |
| `copy.inbox.title` | Needs you |
| `copy.inbox.empty` | All clear. Nothing needs you right now. |
| `copy.inbox.reset` | **{name}** forgot their PIN |
| `copy.inbox.resetMeta` | Asked {time} from {phone} |
| `copy.inbox.claim` | **{phone}** wants to be **{name}** |
| `copy.inbox.locked` | **{name}** is locked out after 5 wrong PINs |
| `copy.inbox.lockedHelp` | They can tap "Ask the family admin" on their phone, then reset it here. |
| `copy.inbox.stale` | **{title}** has been open since {weekday} |
| `copy.inbox.unrated` | **{n} of {m}** rated **{title}** |
| `copy.inbox.alreadyDone` | Someone already took care of that. |
| `copy.inbox.showAll` | Show all ({n}) |
| `copy.stats.title` | At a glance |
| `copy.stats.noNights` | Your first night will show up here. |
| `copy.stats.month` | {n} nights this month |
| `copy.stats.turnout` | {n} watched last time |
| `copy.people.empty` | No one yet. Add the family, or let guests add themselves when they join. |
| `copy.phones.lede` | Phones join with the night code on the TV. Rename or remove them here. |
| `copy.phones.empty` | No phones yet. They show up here after someone joins. |
| `copy.settings.unsaved` | Unsaved changes |
| `copy.settings.saved` | Saved |
| `copy.forbidden.title` | Admins only |
| `copy.forbidden.link` | Go to Home |
| badge label | {n} things need you |

---

## 8. Backend gaps

| Id | Priority | What | Why | Without it |
|---|---|---|---|---|
| **O1** | P2 | `photo_count: int` on `NightSummaryOut` (`GET /sessions`), counting visible, completed photos. One grouped subquery in the list query. | The Photos stat. | The tile is hidden. Nothing else depends on it. |
| **O2** | P1 | `POST /admin/people/{id}/reset-pin` (`admin:people`): same effect as approving a request (clears hash, count, lock; audits `person.pin_reset`) without a request row. | Lets the inbox clear a `locked` row in one tap. Today the locked person must ask from their phone first. | `locked` rows explain the path (`copy.inbox.lockedHelp`) and link to the profile. |
| **O3** | P3 (not now) | `GET /admin/overview` returning all inbox counts and stats in one call. | Fewer requests on Home. | Seven small parallel requests (§6). At household scale this is fine; revisit only if Home is slow on staging. |

No backend change is required to ship this issue. O1 and O2 are small enough to fold into a later
backend PR; both are flagged on #44.

---

## 9. Build plan and file ownership

Because #40 is editing `admin-shell.tsx`, `admin/people/*`, `admin/settings/*`, `(auth)` and
`api.ts`, the build is split:

**Before #40 merges (new files only):**
- `src/lib/portal.ts` + `portal.test.ts`: up-next state machine, inbox merge/priority/thresholds,
  stats (month count, turnout series), greeting, nav filtering by role. 100% coverage gate.
- `src/components/portal/`: `portal-nav.tsx` (sidebar + tab bar + More sheet, presentational, takes
  `items` and `badges`), `up-next-card.tsx`, `inbox.tsx` (rows take callbacks), `stats.tsx`.

**After #40 merges:**
- Replace `AdminShell` with `PortalShell` (admin layout) and wrap `/host` in it (host layout).
- `/host` → `HomeDashboard`; `/admin` → redirect to `/host`.
- People: status column, filter, row ids. Settings: groups + sub-nav, move the TV pairing in.
- Hide admin-only controls for hosts (History correct-winner, nav items).
- Update `04-frontend.md` (route table, Admin section).

Tests: unit tests for `portal.ts` and the components touched (Vitest + Testing Library where the
repo already does). No full suite, no Playwright (CI is disabled for cost); the AC below are written
so a later e2e pass can automate them.

---

## 10. Open questions for the owner

1. **Up-next primary in voting:** should it be **See votes** (go to the night) or **Close voting**
   directly from Home (with a confirm)? The proposal says See votes, because closing early is the
   decision that most needs the turnout in front of you.
2. **Unrated nights:** useful nudge or noise? The proposal shows them, hideable per night.
3. **Hosts and People:** hosts can add guests via the API (`sessions:run`). Should hosts get a
   read-only People page, or is Home enough? The proposal says Home is enough.

---

## 11. Acceptance criteria

Conventions as guest-flow §11: `screen(x)` = `[data-screen="portal-x"]` visible; `primary` =
`getByTestId("primary-action")`. Seeded household **The Baez Family**; accounts `admin` and a
host-only account (`seed_night.py --host-account`). Viewports 1280×800 and 360×640.

**Cross-cutting**
- AC-P0.1: On every portal screen, there is exactly one *enabled* `primary-action` (Settings:
  zero when nothing is unsaved, one otherwise).
- AC-P0.2: At 360×640 the bottom tab bar is visible, every tab is ≥ 56 px tall, and the last content
  row can be scrolled fully above it.
- AC-P0.3: At 1280×800 the sidebar is visible and the tab bar is not.
- AC-P0.4: A host's nav contains exactly Home, History, Settings (phone: Home, History, More). An
  admin's contains Home, People, Phones, Library, History, Settings.
- AC-P0.5: A host opening `/admin/people` sees `admin-forbidden` with a **Go to Home** link to `/host`.
- AC-P0.6: `/admin` redirects to `/host`. Signing in lands on `/host` (`screen(home)`).
- AC-P0.7: No visible text in the portal contains "device", "binding" or "session".

**Up next**
- AC-P1.1 (U0): no active night → `up-next` shows `copy.up.none.title`, primary **Start movie
  night**. Submitting creates one night and the card shows the night code once (U1) with primary
  **Build the shortlist** linking to `/host/{id}`. Reloading shows U2, never the code.
- AC-P1.2 (U2/U3): with 1 title the primary reads **Finish the shortlist**; with 2 it reads **Open
  voting**; both link to `/host/{id}`.
- AC-P1.3 (U4): while voting, the fact reads "{n} of {m} have voted" and updates within 10 s of a
  ballot (live or poll).
- AC-P1.4 (U5): **End the night** opens a confirm; confirming closes the night and the card returns
  to U0 with "Last one: …".
- AC-P1.5: the start form is not in the DOM while any night is draft/voting/revealed/tonight.

**Inbox**
- AC-P2.1: a pending claim appears as a `claim` row for both roles within 10 s; **Approve** removes
  it and the phone's tile flips (guest-flow AC-4.1).
- AC-P2.2: an open PIN reset appears for the admin as a `pin-reset` row above any claim, and never
  for the host (and the host sends no `/admin/people/pin-resets` request).
- AC-P2.3: **Reset PIN** → confirm → `POST …/approve` → the row is gone, and the requesting phone
  moves from S6 to S3c (guest-flow AC-5.x).
- AC-P2.4: a locked person with no open request appears as a `locked` row with `copy.inbox.lockedHelp`.
- AC-P2.5: a night active for > 18 h appears as `stale-night`; a closed night from the last 14 days
  with fewer ratings than turnout appears as `unrated`; **Hide** on it keeps it hidden after reload.
- AC-P2.6: nothing pending → the inbox shows `copy.inbox.empty` and the nav badge is absent.
- AC-P2.7: the Home badge count equals the number of inbox rows (hidden `unrated` excluded).
- AC-P2.8: resolving a row that someone else already resolved shows `copy.inbox.alreadyDone` and
  refreshes the list.

**Stats**
- AC-P3.1: with ≥ 1 past night, **Last night** shows the newest night's winner, date and average,
  and links to that night.
- AC-P3.2: **Turnout** shows ≥ 2 bars and an `aria-label` listing the numbers; hidden with < 2 nights.
- AC-P3.3: **Photos** is absent while `photo_count` isn't in the response.

**People / Settings**
- AC-P4.1: People rows show `PIN set` / `No PIN yet` / `Locked` from `has_pin`/`locked`, and the
  "Needs attention" filter shows only locked or no-PIN people.
- AC-P4.2: an inbox **See profile** link scrolls to and highlights `#person-{id}`.
- AC-P5.1: Settings shows groups Joining, Movie nights, Streaming, Your account, This browser for
  an admin; only Your account and This browser for a host.
- AC-P5.2: editing a field in one group enables only that group's Save (filled); saving PATCHes only
  that group's fields.
- AC-P5.3: **Use this browser as the TV** lives under This browser, keeps its confirm, and after
  confirming lands on `/tv` signed out.
