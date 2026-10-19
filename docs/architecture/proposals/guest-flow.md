# Proposal: the guest and member flow (QR → night → profile → PIN → vote)

**Status:** Proposal, revised with the owner's answers to §10 (2026-10-17). Nothing here is built
yet.
**Builds on:** [ADR-0002](../decisions/ADR-0002-device-identity-and-join-flow.md) (device identity
and join), [ADR-0004](../decisions/ADR-0004-sse-live-updates.md) (live updates),
[ADR-0008](../decisions/ADR-0008-ctrl-alt-defeat-design-tokens.md) (tokens, 56px+ targets) and
ADR-0014 (passwords and required person PINs), which is being written in a parallel session as
this proposal is drafted. ADR-0014 was read as a working draft from that session's worktree, and
its routes were not written yet. Re-check §8 against the merged ADR before building.
**Consumer:** the frontend screens in issue #40, built against this branch as the source of truth.
**Related issues:** #39 (ADR-0014 backend; it closes the gaps in §8), #40 (frontend screens, §5 and
§11), #42 (staging finalization and owner verification, including the timing check AC-12.1).

---

## 1. Executive summary

The first phone test on staging (2026-10-17) got stuck on *"You're in as RooDog. Voting opens on
the TV."*, a screen with nothing to tap while voting was open. PR #35 fixed that one bug. The cause
underneath is structural: today's flow is a chain of **stations** (`/j` → `/who` → a button →
`/s/[id]`). Each station waits for the user to find the next step, and each can go stale.

This proposal replaces the stations with **one resolver**. The phone always asks "who is this
phone acting as, and what is the night doing?" and shows the single screen that answers it. The
screen changes by itself when either answer changes. Concretely:

1. **The phone never needs to tap through to the night.** Once it has a current person, it lands
   on the night: the ballot while voting is open, the winner after the reveal, the photo drop
   during the movie.
2. **The TV QR can carry the night code, if the admin turns it on.** A new household setting,
   "Include tonight's code in the TV QR", is **off by default** (owner decision). When it's off,
   the TV QR is the same door as the fridge QR (`/j/{slug}`) and the code is typed. When it's on,
   the QR is `/j/{slug}?code=XXXXXX`, and the join page pre-fills the code for one confirming
   tap (RFC 8628's `verification_uri_complete` pattern).
3. **A returning phone skips the code and the PIN.** Its device cookie is already the credential
   (ADR-0002), and it is already set to its person (ADR-0014 `is_current`).
4. **ADR-0014 fits into one sheet over the avatar grid**: a big keypad that submits on the 6th
   digit. It covers enter PIN, create PIN, wrong PIN, locked and "Ask the family admin". Only an
   admin can reset a PIN (owner decision). Each state leads to a next action, never to a dead end.
   A shared phone asks for each person's PIN on **every** switch.
5. **Every waiting screen says what it is waiting for, shows live progress, and moves on by
   itself**, and it always offers one way out.

The target is **QR scan to ballot cast in under 30 seconds**. A returning phone takes about 12 s,
and a first-timer with the code-in-QR setting on about 29 s (§6). With the setting off (the
default), a first-timer types the code and comes in at about 34 s. That is the honest cost of the
owner's privacy default, and §6 says where the seconds go.

Four backend gaps against ADR-0014's API need closing before the frontend can meet this spec
(§8). The biggest are: the TV can't get the join slug or the new setting, the person tile
doesn't say a PIN reset is pending, and the wrong-PIN error needs a machine-readable
`attempts_left`. The owner's answers are recorded in §10.

---

## 2. Research findings

Sources were read on 2026-10-17. The Kahoot and Jackbox findings come partly from secondary
sources, as marked.

| Product | What it does | Takeaway for us |
|---|---|---|
| **Kahoot** | No account. You join by entering a game PIN, opening a link, or scanning a QR. An optional nickname generator spins a name for you. The lobby echoes your name on the big screen. Rejoining after leaving usually means a new nickname. ([support.kahoot.com](https://support.kahoot.com/hc/articles/360039890713), search snippet only; [digitalcitizen.life](https://www.digitalcitizen.life/how-to-join-a-kahoot-game-web-mobile/)) | Adopt QR-or-code entry and the echo on the big screen. Reject the weak rejoin. |
| **Jackbox** | A 4-letter room code plus a name at jackbox.tv. The code stays on the TV all game. The first player to join is the VIP. Reconnecting means retyping the code and the *exact* same name; otherwise you land in the audience. (Secondary sources: [fullcoll.edu](https://library.fullcoll.edu/?p=17782), [jackboxgames.com](https://jackboxgames.com/the-jackbox-party-pack-5-streamers-guide/)) | Adopt "the code stays on the TV". Reject name-matching reconnects: our device token resumes in one tap. |
| **Netflix** | A 4-digit Profile Lock per profile. "Forgot PIN?" re-verifies the account (password, email or SMS). There is an option to require the PIN to add new profiles. Kids profiles cap the maturity rating and can't reach settings. ([help.netflix.com](https://help.netflix.com/en/node/114277)) | Adopt the avatar-tile picker and a per-profile PIN. Reject self-service reset: our guests have no account, so the family admin approves instead (ADR-0014). |
| **Disney+** | A 4-digit profile PIN, reset by email. Junior Mode has a "Kid-Proof Exit" reading challenge. ([disneyplus.com](https://www.disneyplus.com/en-gb/explore/articles/parental-controls-guide-disney-plus)) | Reject the reading challenge. It shuts out pre-readers and doesn't stop older kids. |
| **TV device flow (RFC 8628)** | A short code from an alphabet with no look-alike characters, normalized server-side. `verification_uri_complete` puts the code inside the QR URL, but the device still shows the plain code. Codes expire, the phone polls about every 5 s, and code entry is rate-limited. ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) | Adopt the code in the QR plus a plain-code fallback. We already have the no-look-alike alphabet, the expiry (ADR-0002) and the 5 s poll. |
| **Plex Home** | Fast user switching. A user with a PIN needs it to switch, and Plex tells admins to always set one. ([support.plex.tv](https://support.plex.tv/articles/204232453-fast-user-switching/)) | This is exactly ADR-0014's "PIN on switch" for shared phones. Plex shows the friction is accepted. |
| **Spotify Jam** | The host shows a QR, including on the TV app. Guests scan it and tap Join, with no Premium needed. ([support.spotify.com](https://support.spotify.com/pg/article/jam/)) | Adopt the QR on the TV with one tap to join. |
| **Discord invites** | Invites expire, can cap uses, and can grant temporary membership. ([support.discord.com](https://support.discord.com/hc/articles/208866998)) | We already have this: the night code dies at `closed`. |
| **Apple Ask to Buy** | The child asks, and the organizer approves or declines with Face ID or a password. The child is told when a request is declined, and a dismissed request must be sent again. ([support.apple.com](https://support.apple.com/105055)) | This is the model for Forgot PIN: one request, a visible status, and approval by the family admin. |
| **NIST SP 800-63B-4** | Caps consecutive failures at 100 at most, and lower is allowed. Reset the count on success. A disabled authenticator must be re-bound. ([pages.nist.gov](https://pages.nist.gov/800-63-4/sp800-63b.html)) | ADR-0014's 5 attempts plus admin reset sits inside this. A disabled authenticator "must be re-bound": we set a new PIN after approval. |
| **NN/g, children** | Ages 3–5 can't read, and ages 6–8 read slowly and skip instructions. Kids type slowly, expect pictures to be tappable, and avoid scrolling. ([nngroup.com](https://www.nngroup.com/articles/childrens-websites-usability-issues/)) | Avatars as pictures, minimal typing, no scrolling to reach the main action, and short copy. |

**Adopted**

1. The **night code inside the TV QR**, as an admin opt-in (off by default), with the typed code
   always available.
2. **Auto-submit** a typed night code and the PIN at the 6th valid character, so there's no Join
   or OK button to find. A code pre-filled from the QR waits for one **Join** tap (owner decision),
   so the guest sees what is happening.
3. **Big avatar tiles** as the picker. A **"Continue as RooDog"** shortcut is unnecessary because
   the phone is already set to RooDog (ADR-0014 `is_current`) and skips the grid entirely.
4. **A custom 0–9 keypad**, with keys ≥ 64px and digits shown as dots.
5. **Remaining tries are shown from the first wrong PIN.** The research suggests hiding them until
   the 3rd miss. We have only 5 tries and the lock lasts until an admin acts, so an accidental
   lockout costs far more than the tiny help the count gives a guesser.
6. **Ask-to-Buy-style recovery**: "Ask the family admin" sends one request and shows its live
   status. Locked and Forgot PIN share this one queue, and only admins answer it.
7. **The TV echoes progress** without showing picks ("5 of 7 voted", turnout tiles). This is
   already built.
8. **The code stays on the TV all night** (already built).

**Rejected**

1. A new nickname on every rejoin (Kahoot) and exact-name reconnects (Jackbox). The device token
   resumes the session.
2. Self-service PIN reset (Netflix, Disney+). The owner chose admin approval.
3. A reading or maths challenge, or a CAPTCHA, anywhere in the flow.
4. Shortening the night code to 4 letters (Jackbox). ADR-0002 fixes 6 characters. With the setting
   off it costs about 2 s of typing more than 4 letters would, which isn't worth reopening an
   accepted ADR.
5. Growing waits between wrong PINs (NIST's suggestion). The 5-try lock plus ADR-0014's per-device
   budget already covers it. A timer would confuse a kid more than it slows a guesser.

---

## 3. The model: one resolver, three questions

Every phone screen derives from three facts, each kept fresh:

| Fact | Source today | Freshness |
|---|---|---|
| **D: does this phone have a device?** | `GET /api/v1/people` → 401 means no | On load; any 401 later resets the flow to S1 |
| **P: who is this phone acting as?** | `GET /api/v1/people`: the tile with `current: true` (ADR-0014), plus the tiles with `binding: "mine"` | Refetched after every claim, switch or create. Polled every 5 s while a claim or reset is waiting (the `pendingPollInterval` pattern) |
| **N: what is the household's live night?** | `GET /api/v1/sessions?status=draft&status=voting&status=revealed&status=tonight&limit=1`, then `useLiveSession(id)` for that night | Nights list: 5 s poll plus refetch on focus. The night itself: SSE with a poll fallback (ADR-0004) |

```
resolve(D, P, N):
  no device                      → S1 Join (or S0 if the slug is unknown)
  device, no current person      → S2 Who's watching?
  current person without a PIN   → S3c Create PIN (legacy binding, ADR-0014 migration)
  current person, N = none       → S8 No night yet
  current person, N = draft      → S9 Almost ready
  current person, N = voting     → S10 Ballot, or S11 Picks are in if this person already voted
  current person, N = revealed   → S12 Winner
  current person, N = tonight    → S13 Tonight
  current person, last night closed and not rated → S14 How was it?
```

The resolver is the **only** place that navigates. Screens don't link to each other except
through it. That is what removes dead ends: a stale screen re-resolves instead of waiting for a
tap.

Recommended routes. The fridge QR target `/j/[slug]` and `/s/[session]` keep their URLs. `/`
becomes the resolver for any browser with a device cookie, and `/who` becomes the S2 grid that the
resolver redirects to.

```mermaid
flowchart TD
  QRF["Fridge QR<br/>/j/baez"] --> HAS{"Device cookie<br/>valid?"}
  QRT{"TV QR: admin setting<br/>'code in QR'"}
  QRT -- "off (default)<br/>/j/baez" --> HAS
  QRT -- "on<br/>/j/baez?code=ABC234" --> HAS
  HAS -- yes --> RES((Resolver))
  HAS -- "no, ?code= in URL" --> PRE["S1 Join<br/>code pre-filled, tap Join"]
  HAS -- "no, no code" --> S1["S1 Join<br/>type the code (auto-submits at 6)"]
  PRE -- "tap Join, ok" --> RES
  PRE -- "code expired" --> S1
  S1 -- ok --> RES
  S1 -- "wrong / 429" --> S1
  RES -- "no current person" --> S2["S2 Who's watching?"]
  S2 -- "tile with PIN" --> S3E["S3e Enter PIN"]
  S2 -- "tile, no PIN yet" --> S3C["S3c Create PIN"]
  S2 -- "I'm new here" --> S7["S7 New guest"] --> S3C
  S2 -- "on another phone, no PIN" --> S4["S4 Waiting for the host"]
  S3E -- "right PIN" --> RES
  S3E -- "wrong (tries left)" --> S3E
  S3E -- "5th wrong / locked" --> S5["S5 Locked"]
  S3E -- "Forgot PIN" --> S6["S6 Asked the family admin"]
  S5 -- "Forgot PIN" --> S6
  S5 -- "Back to everyone" --> S2
  S6 -- "admin approved, this phone" --> S3C
  S6 -- "admin dismissed" --> S5
  S3C -- "PIN set" --> RES
  S4 -- approved --> RES
  S4 -- rejected --> S2
  RES -- "N = none" --> S8["S8 No movie night yet"]
  RES -- "N = draft" --> S9["S9 Almost ready"]
  RES -- "N = voting" --> S10["S10 Ballot"]
  S10 -- Done --> S11["S11 Your picks are in"]
  S11 -- "Pass to next person" --> SW["Switch sheet"]
  SW -- "tap a person" --> SWP["S3s Switch PIN<br/>(every switch)"]
  SWP -- "right PIN" --> RES
  SWP -- "wrong (tries left)" --> SWP
  SWP -- "5th wrong / locked" --> S5
  SWP -- "close" --> SW
  S5 -- "Back to everyone (switch only: the sheet's list)" --> SW
  RES -- "N = revealed" --> S12["S12 The winner"]
  RES -- "N = tonight" --> S13["S13 Tonight: add photos"]
  RES -- "closed, not rated" --> S14["S14 How was it?"]
  S8 & S9 & S11 & S12 -. "live: night changes" .-> RES
```

---

## 4. Screen rules (apply to every screen)

1. **Exactly one primary action.** It is the only filled (cinema) button, marked
   `data-testid="primary-action"`. On a **waiting screen** the primary action is the automatic
   transition instead. Such a screen has no primary button. It carries
   `data-testid="waiting"`, an `aria-live="polite"` status line saying what it waits for, and a
   live progress fact (for example "5 of 7 voted").
2. **At most two secondary actions**, as `secondary` or ghost buttons and text links (rule 9). One is always
   the way out: *Not you? Switch*, *Pick someone else*, or *Back*.
3. **No dead end.** Every screen, error states included, has a primary action or an announced
   automatic transition, and also a way out. "Scan the QR again" is never the only thing on a
   screen except S0 (§5).
4. **The main action is reachable without scrolling** on a 360×640 viewport (NN/g: kids don't
   scroll). The primary button is sticky at the bottom when the content is long (the ballot
   already does this).
5. **Tap targets**: buttons and tiles ≥ 56px tall (ADR-0008), keypad keys ≥ 64px.
6. **Live, not refreshed.** Waiting screens update through SSE or the 5 s poll. After the phone
   wakes, everything refetches (`refetchOnWindowFocus` and `LiveConnection.wake()`). A
   "Reconnecting…" chip appears only after **10 s** of `reconnecting`, so a planned 30-minute
   stream close never flashes it.
7. **A stale action re-resolves.** If the server refuses an action because the world moved on
   ("Voting is not open", 403 binding gone), the phone refetches, resolves, and shows a one-line
   notice on the new screen. It never leaves an error on a screen that no longer applies.
8. Every screen root carries `data-screen="<id>"` (the ids below) so a Playwright spec can assert
   where the phone is.
9. **Enabled must look enabled.** On the dark theme the `outline` button variant reads as
   disabled (found on the tonight screen, 2026-10-17). Standalone secondary actions use the
   `secondary` variant (solid neutral fill, full-contrast text). `outline` is kept for inline
   controls inside a card (Retry, Change my picks) and never for the only other action on a
   screen. Muted text (`text-muted-foreground`) is never placed directly above a button as if it
   were its label, and no plain sentence starts with a verb that names an action ("Rate later",
   "Add…") unless it is the control itself.

---

## 5. Screen-by-screen spec

Copy is in §7, keyed by the `copy.*` ids used here. Built in issue #40.

### S0 — Landing, no device and slug unknown (`/`)
- **When:** no device cookie, and this browser has never opened a join link.
- **Shows:** the "Scan the QR" illustration and `copy.s0.*`.
- **Primary:** none. The camera is the action. This is the one allowed instruction-only screen,
  because without a slug the app can't know which household to open.
- **Change:** `/j/[slug]` stores the slug and household name in `localStorage`
  (`fnh.lastJoin`, guarded like `night-code-handoff.ts`). When that key exists, S0 is replaced by
  S1's link: **Join The Baez Family** (primary). This covers a phone whose cookie was cleared.
- **Secondary:** "Hosting? Sign in".

### S1 — Join (`/j/[slug]`)
- **When:** no valid device. **With a valid device cookie, `/j/[slug]` skips straight to the
  resolver.** It probes `GET /people`, and a 200 means the phone is already in. Today it always
  asks for the code (deviation D1).
- **Code from the TV QR** (only when the admin setting is on): `?code=ABC234`. The page reads it
  once, cleans it with `cleanNightCodeInput`, puts it in the field, and immediately removes it
  from the address bar with `router.replace("/j/{slug}")`, so it doesn't stay in history or get
  shared by a copied link. It is **not** auto-submitted: the field shows the code with
  `copy.s1.prefilled` and the **Join** button is the primary, one tap (owner decision). An
  invalid or look-alike value is dropped and the field stays empty. The `/j` response sets
  `Referrer-Policy: no-referrer`.
- **Code typed** (setting off, the default, or the fridge QR): the field is empty and focused.
- **Typed code:** the field auto-submits when `completeNightCode` returns a value (6 valid
  characters). The **Join** button stays, as the primary, for keyboards that don't fire input
  events, and it reads "Joining…" while pending.
- **After success:** the resolver. `JoinOut.session_id` is already the night, so the resolver can
  prefetch it (today the page goes to `/who` and ignores it, D2).
- **Errors:** wrong or expired code → `copy.s1.wrong`; the field is cleared and focused. 429 →
  `copy.s1.slow` with minutes from `Retry-After`; the field is disabled until then and the
  secondary is "Ask the host to let this phone in". Look-alike characters → the existing hint.
- **Secondary:** "Hosting? Sign in".

### S2 — Who's watching? (`/who`)
- **When:** device, no current person; or the user tapped **Switch**.
- **Shows:** avatar tiles (emoji, colour, name). Family first, then guests, then the last tile,
  **＋ I'm new here** (S7). The tile states map from ADR-0014's `PersonTile`:

  | Tile state (`binding`, `has_pin`, `locked`, `current`) | Badge | Tap goes to |
  |---|---|---|
  | `current` | ✓ "That's you" | the resolver (no PIN) |
  | `mine`, not current, `has_pin` | — | S3e Enter PIN (a switch) |
  | `mine`, `!has_pin` (legacy binding) | "Needs a PIN" | S3c Create PIN (`POST …/pin`) |
  | `free`, `has_pin` | — | S3e Enter PIN |
  | `free`, `!has_pin` | "New" | S3c Create PIN (first claim) |
  | `taken`, `has_pin` | 📱 "On another phone" | S3e Enter PIN (the right PIN joins, no host needed) |
  | `taken`, `!has_pin` | 📱 "On another phone" | S4 Waiting for the host (claim sent without a PIN) |
  | `pending` | ⏳ "Waiting for the host" | S4 |
  | `locked` | 🔒 "Locked" | S5 (or S6 if a reset is already asked, needs G2) |

- **Primary:** tapping a tile. The grid itself is the action, so there is no button. Exactly one
  `primary-action` exists: the grid (`role="list"` with tiles as buttons).
- **Removed:** the "You're in as … / Vote now" status block and button. The phone never stays on
  S2 once it has a current person (D3).
- **Empty household:** only the **＋ I'm new here** tile shows, with `copy.s2.empty` above it.
  That is not a dead end, because self-create is open to anyone with the night code.
- **Secondary:** "Hosting? Sign in".

### S3 — PIN sheet (bottom sheet over S2 or the switch sheet)
One component, four states. The avatar and name are at the top, six dots, and a 3×4 keypad
(1–9, *Back* ⌫, 0, *Clear*). It submits on the 6th digit, so **the keypad is the primary
action** and there is no OK button. A close ✕ returns to S2.

- **S3e Enter PIN:** `PUT /devices/me/people/{id} {pin}`. Success → the resolver (the person is now
  current). **Wrong** → the dots shake, clear, and `copy.s3.wrong` shows *with* the tries left
  (from `attempts_left`, needs G3). The 5th wrong (423) → S5. **Forgot PIN?** is a text link →
  `POST …/forgot-pin` → S6. A 429 per-device budget → `copy.s3.slow`.
- **S3c Create PIN:** two steps on one sheet. Step 1 is "Choose a 6-digit PIN" and step 2 is
  "Type it again". A mismatch → `copy.s3.mismatch` and back to step 1. Success → the resolver.
  Under the name, a quiet link **Not your name? Change it** (first claim only, while
  `can_rename`) opens the rename field *after* the PIN is set. It is a secondary action and stays
  off the critical path.
- **S3s Switch PIN** (from the switch sheet, see below): the same Enter PIN sheet, titled
  `copy.s3s.title`, with the current person named under it (`copy.s3s.still`). Every switch asks
  for the PIN, even between people who used this phone a minute ago (owner decision; ADR-0014).
- **Kids:** the same sheet. People have no age or kid flag (only `is_guest`), so the sheet always
  shows the quiet line `copy.s3.kidHint` under the dots. There is no separate kids flow.
- **Who sees the digits:** dots only. A press-and-hold eye icon shows the digits while held
  (useful for grandparents). The input keeps `autocomplete="off"`, so password managers don't
  offer to save a kid's PIN.

### S4 — Waiting for the host (pending claim)
- **When:** a claim went `pending`. That happens when the person has no PIN and is on another
  phone, or the person has a PIN and the user chose **Ask the host instead** on S3e (the ADR-0014
  admin override, offered as a secondary link after 2 wrong PINs).
- **Waiting:** `copy.s4.*`. The people list polls every 5 s; approved → the resolver, rejected →
  S2 with `copy.s4.rejected`.
- **Way out:** **Pick someone else** (→ S2). The pending claim stays, so the host can still
  approve it.
- **Host side:** the claim appears on `/host` (already built), and the TV shows a nudge (§5 TV).
- **Not a PIN unlock.** Approving a pending claim lets this phone act as the person; it never
  resets, reveals or bypasses a lock. A locked person refuses pending claims too (423, ADR-0014),
  so a locked tile always goes to S5, never S4.

### S5 — Locked
- **When:** a 423, or a `locked` tile tapped.
- **Primary:** **Forgot PIN** (`copy.s5.button`) → `POST …/forgot-pin` → S6, with
  `copy.s5.helper` ("We'll ask the family admin to reset it.") on the line under it and tied to it
  with `aria-describedby`. Only admins can reset a PIN (owner decision); hosts can't, so the copy
  never says "ask the host" here. *Changed 2026-10-18 (issue #70): the owner didn't recognise
  "Ask the family admin to reset your PIN" as Forgot PIN.*
- **Way out:** **‹ Back to everyone** (`copy.s5.back`, `data-testid="locked-back"`), the first
  thing on the screen, above the person, so it is in the viewport at 360×640 without scrolling.
  On /who it returns to S2; in the switch sheet, to the sheet's list of people.
- Copy says what happened without blame (`copy.s5.*`) and that nothing else changes. Phones
  already set to them keep working, as ADR-0014 decides.

### S6 — Asked the family admin (reset pending)
- **When:** a forgot-PIN request is open for this person (from this phone, or found from the tile
  after a reload, needs G2).
- **Waiting:** `copy.s6.*`, with a live poll every 5 s. **Approved for this phone** → S3c Create
  PIN (the ADR lets the requesting phone set it even if another phone holds the person).
  **Dismissed** → S5 with `copy.s6.dismissed`. Approved but asked from another phone → S3e with
  `copy.s6.otherPhone`.
- **Way out:** **Pick someone else**.
- **Where the request goes:** only to the admin owner portal, `/admin/people` (§5 "Admin"). It
  never appears on `/host` for a host who isn't an admin, or on the TV.

### S7 — New guest (self-create)
- One screen, then S3c. **Name** (a large text field, `autocapitalize="words"`), **pick a
  picture** (8 one-tap emoji, reusing the admin suggestions), colour from the avatar palette with
  no picker. **Primary:** **Next** (enabled once the name is 1–40 characters and an emoji is
  chosen).
- **Then S3c** creates the PIN. Only then is `POST /devices/me/people {name, avatar_emoji, color,
  pin}` sent: one request, as ADR-0014 specifies. A name clash (409) returns to S7 with
  `copy.s7.taken`, which offers **That's me** (→ S2 with that tile highlighted) or a name edit.
- Self-create budget 429 → `copy.s7.slow`, with **Pick someone else** as the way out.

### Here tonight strip (S9, S10, S11, S13)
Owner request (2026-10-17): the phone's night screens show **who's here tonight** and update live,
like the TV's turnout tiles. **It never shows how anyone voted.**

- **Who counts as here:** anyone who voted on this night, plus anyone whose phone opened this
  night while set to them (needs G8). Until G8 ships, the strip shows voters only and its label
  reads `copy.here.votedOnly`, so it never claims to know who is in the room.
- **What it shows:** a row of avatars (emoji on the person's colour) with first names under them,
  family first, then guests, in the server's order. While voting is open, people who have voted
  get a small ✓ badge, and the count reads `copy.here.countVoting`. That is the same fact the TV
  already shows (ADR-0006: who voted, never what). The ✓ disappears after `voting`.
- **Sizes and placement:**
  - S9, S11 and S13: the full row, 48px avatars, right under the `copy.chip` header. It wraps to
    a second line, then collapses the rest into `+N`.
  - S10 (ballot): one compact line, 32px overlapping avatars plus the count, so the posters and
    the sticky **Done** stay above the fold (§4 rule 4).
- **Not a control.** The strip is a `<ul aria-label="Here tonight">` of non-interactive items: no
  button role, no hover or press state, so nobody taps it expecting something (§4 rule 9). Names
  come from `GET /people`, which the phone already holds; the presence data carries ids and
  avatars only.
- **Live:** it is keyed under the night (like `votersKey`), so every stream event refetches it,
  and it polls only while the stream is down. Only the count line is an `aria-live="polite"`
  region; avatars appearing are not announced one by one.
- **Empty:** the strip is hidden until at least one other person is here. Showing just yourself
  adds nothing.

### Switch sheet (shared phone, ADR-0014 "one current person per phone")
- **Opened from:** the **Not you? Switch** chip on every night screen, and **Pass to next
  person** on S11.
- **Shows:** `copy.switch.title`, then the people this phone holds (`binding: "mine"`) as big
  tiles. The current person is first, marked "That's you" and not tappable. While voting, the
  others show "Voted ✓" or nothing. A `locked` person shows 🔒 "Locked". Then
  **＋ Add someone to this phone** (→ S2), and **Remove from this phone** (⋯ on a tile, `DELETE`
  binding, confirm first).
- **Primary:** tapping a person's tile (the grid is the action, as on S2).
- **Every switch asks for the PIN** (owner decision, ADR-0014). A tap opens **S3s Switch PIN**
  for that person. `PUT /devices/me/people/{id} {pin}`:
  - **Right PIN** → they become current, and the resolver lands them on their own screen (their
    ballot while voting). The chip now reads `copy.chip` with their name.
  - **Wrong PIN** → the dots shake and clear, and `copy.s3.wrong` shows the tries left. **The
    current person does not change**: `copy.s3s.still` stays under the dots ("Still set to
    RooDog"). Closing the sheet returns to the switch sheet with RooDog still current, so a
    wrong PIN never leaves the phone set to nobody.
  - **5th wrong PIN (423)** → S5 for **that** person (`copy.s5.*`, primary **Forgot PIN**). Its
    way out is `copy.s5.back` ("Back to everyone"), which returns to the switch sheet's list, not
    to S2; closing the sheet returns to RooDog's screen. The previous person stays current
    throughout. The locked person keeps
    their 🔒 tile on the sheet. Tapping it later goes straight to S5, or to S6 if a request is
    already open (G2).
  - **Per-device budget (429)** → `copy.s3.slow`. The sheet closes back to the switch sheet,
    and the current person is unchanged.
  - **Forgot PIN?** → S6 for that person, way out `copy.switch.backTo`.
- Today's multi-person "Who's voting?" grid inside `voting-flow.tsx` is replaced by this sheet
  (D5).

### S8 — No movie night yet
- **Waiting:** `copy.s8.*`. The nights list polls every 5 s and on focus; a night appears → the
  resolver.
- **Secondary:** **Past movie nights**, **My profile**, the **Switch** chip.
- Also shows the "How was *Movie*?" card while a rating is owed (already built).

### S9 — Almost ready (`draft`)
- **Waiting:** `copy.s9.*` with the live count of shortlisted titles (`options.length` from the
  snapshot, SSE). Voting opens → **S10 by itself**, with no tap. The `/s/[id]` status switch
  already does this; the fix is that the phone is here, not on `/who`.
- **Secondary:** the **Switch** chip.

### S10 — Ballot (`voting`)
- Unchanged from today's `BallotForm`, apart from the header: "Voting as **RooDog** · Switch".
  **Primary:** **Done** (sticky).
- **Voting closes mid-ballot:** the snapshot flips to `revealed` and the screen re-resolves to S12
  with `copy.s10.closed`. Unsaved picks are dropped, and the notice says so.

### S11 — Your picks are in (`voting`, this person voted)
- **Single-person phone, waiting:** `copy.s11.*` with live "5 of 7 voted" (`GET …/voters`, already
  polled by the TV hook). Reveal → S12 by itself.
- **Shared phone:** **Pass to next person** is the primary (→ switch sheet), offered while anyone
  on this phone hasn't voted. Otherwise it is the waiting variant.
- **Secondary:** **Change my picks**.

### S12 — The winner (`revealed`)
- **Waiting:** winner card plus results. The settle to `tonight` is polled (`nightPollInterval`,
  already built) → S13 by itself, with `copy.s12.*`.
- **Secondary:** **See all results** (expands).

### S13 — Tonight (`tonight`)
Owner feedback from the first phone test (2026-10-17): the line "Rate later: we'll ask how it was
after the movie" sat above an **outline** "Rate it now" button. On a dark phone screen the outline
button looked greyed out, the sentence read like a missing button, and the owner was surprised
rating was allowed. The hierarchy, top to bottom, is now fixed:

| # | Element | Style | Notes |
|---|---|---|---|
| 1 | Winner card (compact) | info only | As built; the one place the cinema accent glows. |
| 2 | **Add photos** | **primary** (filled, `default` variant, `tap` size) | The `PhotoDrop` label. On an empty album this becomes the empty-state tile (below), so there is still exactly one primary. |
| 3 | Upload list, then album grid | content | Album refreshes every 10 s (`ALBUM_REFRESH_MS`) and on focus, so other phones' photos appear without a reload. |
| 4 | **Already watched? Rate it** | **secondary** (`secondary` variant: solid neutral fill, full-contrast text, `tap` size) | Unfolds `RatingPanel` in place (as built). No sentence above it. |

- **Removed:** the "Rate later: we'll ask how it was after the movie" sentence and the card around
  it. What it explained (we ask again after the movie) is already true through the home card, and
  a sentence above a button reads as a label for a control that isn't there.
- **Empty album** (`photos.length === 0`): instead of the passive "No photos yet." line plus a
  separate button, the drop **is** the empty state: a large tile (min 160px tall, dashed border,
  camera icon) carrying `copy.s13.emptyTitle` and `copy.s13.emptyBody`, and the whole tile is the
  `Add photos` file picker label (`data-testid="primary-action"`). The standalone Add photos
  button is not rendered while the album is empty. Once the first photo lands (this phone's upload
  or the 10 s refresh), the tile collapses to the normal button above the grid.
- **No "Pick who you are to add photos" link.** Under the resolver a phone on S13 always has a
  current person, so the outline link in `PhotoAlbum` (today's `mine.length === 0` branch) can't
  appear here. It stays only for `/albums/[session]` opened directly by a phone with nobody set,
  where it routes through the resolver.
- **Shared phone:** the "Sharing as" chips stay, but default to the current person (ADR-0014),
  not `mine[0]`.
- The same rules apply to S14 and the `closed` screen: one filled primary, and every other
  enabled action uses the `secondary` variant (§4 rule 9).

### S14 — How was it? (`closed`, rating owed)
- **Primary:** the star row (a tap saves, as built). After rating → **Past movie nights**
  becomes the primary.
- `closed` with nothing owed → S8 (no night) or the next night.

### Profile (`/me`, then `/people/[id]`), off the critical path
- Name (**Change my name**, once, while `can_rename`), **Change my PIN** (current PIN → new PIN),
  history and stats from `GET /people/{id}/profile`. Reached from **My profile** on S8 and from
  the switch sheet.

### Host on their own phone
- Signed in (`fnh_session`). **Change:** `/host` gets a **"Vote as Rodolfo"** card while voting is
  open and this browser holds a current person. It links to `/s/[id]`. Without a device the card
  reads **Join as a voter on this phone**, which uses the existing `devices/enroll` host path, so
  no night code is needed.
- **Pending claims only** on `/host` (already built, `devices:approve`). PIN resets are **not**
  shown to hosts (owner decision). If the signed-in account is also an admin, `/host` shows one
  extra line, `copy.host.adminResets`, linking to `/admin/people#pin-requests`.

### Admin (`/admin/people` and `/admin/settings`), the owner portal
- **PIN requests** (new section at the top of `/admin/people`, `id="pin-requests"`): one row per
  open request with the avatar, name, "asked {time} from {device label}", and whether the person
  is locked. **Reset PIN** (primary for the row, confirm dialog with `copy.admin.resetConfirm`)
  and **Dismiss**. After a reset, the requesting phone moves from S6 to S3c by itself. The admin
  nav shows a count badge while requests are open, polled every 10 s.
- **Setting: "Include tonight's code in the TV QR"** on `/admin/settings`, under **Join link**.
  A switch, **off** by default, with `copy.admin.qrCode.label` and `copy.admin.qrCode.help`.
  Saved with `PATCH /admin/settings` (G9). The change reaches the TV on its next settings
  refetch (≤ 10 s) or reload. No phone is affected.

### TV (`/tv/[session]`)
- **Lobby, draft and voting:** a big QR, the night code in large type under it, and
  `copy.tv.scan` / `copy.tv.scanType`. The turnout tiles are already built. Which QR depends on
  the household setting (G1, G9):
  - **Off (default):** the QR is `/j/{slug}`, and the label is `copy.tv.scanType` ("Scan, then type
    the code"). The code under the QR is what people type.
  - **On:** the QR is `/j/{slug}?code={code}`, and the label is `copy.tv.scan`. The TV builds the
    URL **in the browser** from the code it already holds in `sessionStorage`
    (`night-code-handoff.ts`). The server never stores or returns the plaintext code (ADR-0002
    keeps only its hash). If the TV doesn't hold the code (a new tab, cleared storage), it shows
    the plain `/j/{slug}` QR and the existing "type tonight's code on the TV" prompt until someone
    enters it.
  - The QR is re-rendered when the code rotates or the setting changes.
- **Help nudge:** while a person claim is waiting for the host, a corner line `copy.tv.help`
  ("RooDog is waiting for the host. Check your phone."). PIN resets are never shown on the TV
  (admin only). It needs a TV-readable count (G4).
- After `revealed`: unchanged (reveal, then slideshow).

---

## 6. The 30-second budget

Times are estimates for a mid-range phone on home Wi-Fi. They are to be measured on staging (the
issue's last acceptance box).

| Step | First time, setting **off** (default; TV or fridge QR) | First time, setting **on** (TV QR) | Returning phone | Shared phone, next person |
|---|---|---|---|---|
| Camera to page loaded | 6 s | 6 s | 6 s | — |
| Night code | 8 s (type 6, auto-submit) | 2 s (pre-filled, tap Join) | 0 (cookie) | — |
| Pick tile | 3 s | 3 s | 0 (current) | 3 s (switch sheet) |
| PIN | 9 s (create + confirm) | 9 s | 0 | 4 s (enter, every switch) |
| Ballot (3 taps + Done) | 8 s | 8 s | 6 s | 8 s |
| **Total** | **≈ 34 s** ⚠️ | **≈ 28 s** ✅ | **≈ 12 s** ✅ | **≈ 15 s** ✅ |

With the default setting, a first-timer is about 4 s over the target. That is the price of
keeping the code out of the QR, which the owner chose. A first visit happens once per phone; every
later night is the 12 s column. If the staging retest shows first-timers matter more than
expected, the admin can turn the setting on for a party night without a code change. The kid path
adds a hand-over to a parent for the PIN (about 5 s), and that is accepted.

---

## 7. Copy deck

Rules: second person, short sentences, no jargon ("profile", "device", "binding" never appear),
and no blame. Names are interpolated in **bold**. Kid-readable where a kid acts: tiles, ballot,
waiting screens.

| Id | Text |
|---|---|
| `copy.s0.title` | Family Night Hub |
| `copy.s0.body` | Scan the QR code on the fridge or the TV to join movie night. |
| `copy.s0.rejoin` | Join **The Baez Family** |
| `copy.common.hostSignIn` | Hosting tonight? Sign in |
| `copy.s1.title` | Join movie night |
| `copy.s1.lede` | Type the code you see on the TV. |
| `copy.s1.button` / pending | Join / Joining… |
| `copy.s1.prefilled` | We filled in tonight's code from the TV. Tap **Join**. |
| `copy.s1.wrong` | That code didn't work. Check the TV: the code changes every movie night. |
| `copy.s1.slow` | Too many tries. Try again in **{n} minutes**, or ask the host to let this phone in. |
| `copy.s2.title` | Who's watching? |
| `copy.s2.lede` | Tap your picture. |
| `copy.s2.new` | I'm new here |
| `copy.s2.empty` | No one's here yet. Tap **I'm new here** to add yourself. |
| tile badges | That's you · New · Needs a PIN · On another phone · Waiting for the host · Locked |
| `copy.s3e.title` | Hi **{name}**! Type your PIN. |
| `copy.s3.kidHint` | Grown-ups can type it for kids. |
| `copy.s3.wrong` | Not quite. **{n} tries left.** |
| `copy.s3.wrongLast` | Not quite. **1 try left** before {name} gets locked. |
| `copy.s3.forgot` | Forgot PIN? |
| `copy.s3.askHost` | Ask the host to let this phone in |
| `copy.s3.slow` | Too many wrong PINs on this phone. Wait a few minutes and try again. |
| `copy.s3c.title1` | Pick a 6-digit PIN for **{name}** |
| `copy.s3c.hint` | You'll need it if you use another phone. Grown-ups pick it for kids. |
| `copy.s3c.title2` | Type it again |
| `copy.s3s.title` | Switch to **{name}**? Type their PIN. |
| `copy.s3s.still` | Still set to **{current}** until the PIN is right. |
| `copy.s3.mismatch` | Those didn't match. Let's try again. |
| `copy.s3c.rename` | Not your name? Change it |
| `copy.s4.title` | Waiting for the host |
| `copy.s4.body` | **{name}** is on another phone. We asked the host to OK this phone too. This screen moves on by itself. |
| `copy.s4.rejected` | The host said no for **{name}** on this phone. Pick who you are. |
| `copy.common.pickElse` | Pick someone else |
| `copy.s5.title` | **{name}** is locked |
| `copy.s5.body` | Too many wrong PINs. Phones already set to {name} still work. |
| `copy.s5.button` | Forgot PIN |
| `copy.s5.helper` | We'll ask the family admin to reset it. |
| `copy.s5.back` | Back to everyone |
| `copy.s6.title` | We asked the family admin |
| `copy.s6.body` | The family admin will see your request. When they reset your PIN, you'll pick a new one right here. |
| `copy.s6.dismissed` | The family admin didn't reset **{name}**'s PIN this time. Ask them in person. |
| `copy.s6.otherPhone` | **{name}**'s PIN was reset on another phone. Type the new PIN, or ask whoever set it. |
| `copy.s7.title` | Welcome! What should we call you? |
| `copy.s7.picture` | Pick a picture |
| `copy.s7.button` | Next |
| `copy.s7.taken` | There's already a **{name}** here. Is that you? |
| `copy.s7.thatsMe` | That's me |
| `copy.s7.slow` | This phone has added a lot of people. Ask the host to add you. |
| `copy.switch.title` | Who's voting now? |
| `copy.switch.add` | Add someone to this phone |
| `copy.switch.remove` | Remove from this phone |
| `copy.switch.backTo` | Back to **{current}** |
| `copy.chip` | Voting as **{name}** · Switch |
| `copy.s8.title` | No movie night yet |
| `copy.s8.body` | When the host starts one, this screen changes by itself. |
| `copy.s9.title` | Almost ready |
| `copy.s9.body` | The host is picking movies ({n} so far). Voting starts here by itself. |
| `copy.s10.closed` | Voting just closed. Here's the winner! |
| `copy.s11.title` | Thanks, **{name}**! Your picks are in. |
| `copy.s11.body` | **{voted} of {total}** voted. The winner shows here when voting closes. |
| `copy.s11.pass` | Pass to next person |
| `copy.s11.change` | Change my picks |
| `copy.s12.body` | Get the snacks! Photos open in a moment. |
| `copy.s13.primary` | Add photos |
| `copy.s13.emptyTitle` | No photos yet |
| `copy.s13.emptyBody` | Tap here to add the first one: snacks, the couch crew, the screen! |
| `copy.s13.rate` | Already watched? Rate it |
| `copy.here.label` | Here tonight |
| `copy.here.votedOnly` | Voted so far |
| `copy.here.count` | {n} here |
| `copy.here.countVoting` | {n} here · {v} voted |
| `copy.s14.title` | How was **{movie}**? |
| `copy.live.reconnecting` | Reconnecting… |
| `copy.stale.closed` | That changed while you were away. Here's where things are now. |
| `copy.host.vote` | Vote as **{name}** |
| `copy.host.joinVoter` | Join as a voter on this phone |
| `copy.host.help` | {n} phones waiting for you to OK them |
| `copy.host.adminResets` | {n} PIN reset requests (admin) |
| `copy.admin.pinRequests` | PIN requests |
| `copy.admin.resetConfirm` | Reset **{name}**'s PIN? Their old PIN stops working. They'll choose a new one on the phone that asked. |
| `copy.admin.qrCode.label` | Include tonight's code in the TV QR |
| `copy.admin.qrCode.help` | Guests who scan the TV just tap Join. Anyone who sees the TV, or a photo of it, can join until the night ends. Off: they scan, then type the code. |
| `copy.tv.scan` | Scan to join |
| `copy.tv.scanType` | Scan, then type the code |
| `copy.tv.help` | **{name}** is waiting for the host. Check your phone. |

---

## 8. Backend gaps against ADR-0014

ADR-0014's routes were not written when this was drafted. These items close the gap between the
service layer in the draft and what this spec needs. They belong to **issue #39** (backend). #40
can ship each screen's fallback, noted per row, if a gap lands later. P0 means needed to meet the spec. P1 means
the spec works around it.

| # | Gap | Why the spec needs it | Proposal | Priority |
|---|---|---|---|---|
| **G1** | No endpoint gives the TV (or a host) the household's join slug. `tv-night.tsx` hard-codes `JOIN_SLUG = null` and points people to the fridge. | The TV shows a QR in both setting modes (§5 TV). | `GET /api/v1/devices/me/join-link` for `is_tv` devices → `{url, include_code_in_qr}` (see G9). The TV appends `?code={code}` itself, from `sessionStorage`, only when the flag is on. | P0 |
| **G2** | `PersonTile` doesn't say a PIN reset is open, or that one was approved for *this* phone. | S6 must survive a reload, and S2 must route a `locked` tile to S6, not S5, when a request is already open. | Add `pin_reset: null \| "open" \| "approved_for_this_phone"` to the tile (the `_RESET_FOR_ME` query already computes the second). | P0 |
| **G3** | `WrongPin` carries `attempts_left`, but the response shape isn't defined. | S3 shows the tries left, and Playwright asserts on it, not on prose. | Error body `{detail, code: "wrong_pin", attempts_left}` (422 or 401) and `{detail, code: "pin_locked"}` for 423. Keep the codes stable for the OpenAPI types. | P0 |
| **G4** | Nothing counts pending claims for the TV, and the admin portal needs a cheap count for its badge. PIN resets stay `admin:people` only (owner decision: hosts can't list or approve them), which matches ADR-0014. | The TV nudge for pending claims; the admin nav badge. | `GET /devices/me/help-count` for `is_tv` devices → `{count, first_name}` counting **pending claims only**. An `open_count` on the admin PIN-request list (or a `HEAD`-cheap count route). Add a route test that a host without `admin:people` gets 403 on the reset list and approve routes. | P1 |
| **G5** | Approvals (claims and resets) publish nothing to the phone, and there is no household-level stream. | S4 and S6 must update live. | **Workaround, no backend change:** poll the people list every 5 s while anything is waiting (the existing `pendingPollInterval`, extended to `pin_reset === "open"`). A household stream is a later ADR if polling ever shows up in costs. | P1 |
| **G6** | It isn't explicit that `forgot-pin` is allowed on a **locked** person ("a lock blocks claiming, switching and PIN changes"). | S5's only primary action calls it. | Confirm in the ADR-0014 route tests: `POST …/forgot-pin` on a locked person → 202. | P0 (a test, not a feature) |
| **G7** | The resolver composes `GET /people` and `GET /sessions?…` (two requests per check). | It works, but each wake costs two round-trips. | Optional `GET /devices/me/home` → `{current_person, people_on_phone, live_night: {id, status}}`. | P2 |
| **G9** | No household setting for putting the code in the TV QR. | The owner's opt-in (§10.1), default off. | Add `include_code_in_qr: bool NOT NULL DEFAULT false` to the household settings, readable and writable through `GET/PATCH /admin/settings` (`admin:settings`), and returned to the TV by G1. **No plaintext code is stored or returned:** the server keeps only the hash (ADR-0002), and the TV composes `?code=` from the code it already holds in the browser. Two follow-ups for the backend owner: (1) the `?code=` query reaches the web server, so make sure request logging on `fnh-web` and `fnh-api` drops the query string for `/j/*` (the code is live until `closed`); and (2) send `Referrer-Policy: no-referrer` on `/j/*`. If either is awkward, a `#code=` fragment gives the same UX and never leaves the phone; that is a one-line change on both sides. | P1 (the default-off path works without it) |
| **G8** | `GET /sessions/{id}/voters` (ADR-0006) returns only people **with a ballot** (`person_id`, `avatar_emoji`, `color`), and only `ballot_count` is published. Nothing records that a person *joined* a night: `join_service` audits `device.joined` for a device, not a person, and a returning phone under the resolver never calls `/join` at all. Claims and switches publish nothing. | The Here tonight strip (§5) must include people who joined but haven't voted, and during `tonight`, when nobody votes. | A small attendance record: `session_attendance (household_id, session_id, person_id, first_seen_at)`, household-scoped with FORCE RLS like every table. Upsert it when a device whose **current** person is X mints an SSE ticket for the night or casts a ballot. Publish a `presence` event after commit only when a row is new. Expose `GET /sessions/{id}/present` → `{present: [{person_id, avatar_emoji, color, voted: bool}]}`, so it carries the same fields as `/voters` plus `voted`, with **no ranks or tallies**. The TV can use it too, to dim people who aren't here. | P1 (the strip ships voters-only without it) |

Also checked: no gap. `JoinOut` already returns `session_id` (D2). `join_service` reuses an
existing device for the household rather than minting a new one, so a returning phone that types
the code keeps its people. ADR-0014's self-create is one request with the PIN, which matches S7 →
S3c.

---

## 9. Where today's implementation deviates

| # | Today | Changes to |
|---|---|---|
| D1 | `/j/[slug]` always asks for the code, even with a valid device cookie. | It probes `GET /people`, and on a 200 goes to the resolver. A `?code=` value (setting on) pre-fills the field and waits for one Join tap; 6 typed characters auto-submit. |
| D2 | A successful join goes to `/who` and ignores `JoinOut.session_id`. | It goes to the resolver and prefetches that night. |
| D3 | `/who` is a station: "You're in as … Vote now". The "Waiting for the host to open voting" variant is a waiting screen that the phone has to leave by tapping. | `/who` is only the picker (S2). With a current person the resolver never shows it, and the phone sits on S8, S9 or S10, which advance by themselves. |
| D4 | `/who` lede: "Sharing a phone? Tap everyone using it." (multi-claim). | One current person per phone (ADR-0014). More people are added from the switch sheet. |
| D5 | `voting-flow.tsx` shows its own "Who's voting?" grid for several held people, with no PIN. | Switch sheet plus PIN (ADR-0014 `require_can_act_as` needs `is_current`). The ballot is always for the current person. |
| D6 | A tile tap claims at once (`PUT …/people/{id}` with no body). | Every claim goes through S3 (`{pin}`), except the current person and the explicit "Ask the host instead". |
| D7 | 401 on `/who` and `/s/[id]` shows "This phone hasn't joined tonight yet. Scan the QR…" with nothing to tap. | Resolve to S1 when `fnh.lastJoin` is known (a **Join The Baez Family** button), otherwise S0. |
| D8 | The TV says "Scan the fridge QR to join" (no slug). | QR to `/j/{slug}` by default, or `/j/{slug}?code={code}` when the admin setting is on (G1, G9). |
| D9 | No PIN, lock, reset, self-create, rename or profile screens. | S3 to S7, the switch sheet, the profile. |
| D10 | `/host` lists pending claims only. | Still pending claims only (hosts never see PIN resets), plus the "Vote as …" card and, for admins, a link to the PIN requests. PIN requests live on `/admin/people`. |
| D12 | `tonight`: "Rate later: we'll ask…" sentence above an **outline** "Rate it now" (read as disabled on a phone); empty album is a passive "No photos yet." line. | S13 hierarchy: **Add photos** primary, empty album becomes the Add photos tile, **Already watched? Rate it** as a `secondary` button with no sentence above it (§4 rule 9). |
| D13 | Phones show no one else; only the TV has turnout tiles (`useVoters`, voters only). | The Here tonight strip on S9/S10/S11/S13, from `/present` (G8), falling back to `/voters`. |
| D11 | Live-night discovery on `/who` covers `voting/revealed/tonight` (PR #35). | The resolver also includes `draft` (S9), so a phone that joins early sits on "Almost ready" and slides into the ballot. |

---

## 10. Owner decisions (answered 2026-10-17)

1. **Does the TV QR carry the night code? Off by default.** A household setting, "Include
   tonight's code in the TV QR", lives on `/admin/settings`. When it's on, the QR is
   `/j/{slug}?code=XXXXXX`, and the join page pre-fills the code for one Join tap. When it's off,
   the QR is `/j/{slug}` and the code is typed. Specified in §5 S1, TV and Admin; G1 and G9.
2. **Who resets PINs? Admins only.** Hosts can't. Forgot PIN and locked requests go to the admin
   owner portal (`/admin/people`) only, and the copy says "the family admin". Specified in §5
   S5, S6 and Admin; G4.
3. **Does a shared phone ask for the PIN on every switch? Yes.** Each switch needs that person's
   PIN. A wrong PIN or a lock during a switch never changes the current person. Specified in §5
   "Switch sheet" and S3s.

No open questions remain for this spec. The two G9 follow-ups (log scrubbing and the referrer
header for `?code=`) are for the backend owner, not product decisions.

---

## 11. Acceptance criteria (per state, Playwright-ready)

Conventions: `screen(x)` means `[data-screen="x"]` is visible. `primary` is
`getByTestId("primary-action")`, and every screen has **exactly one** primary or one `waiting`
(asserted by a shared helper, `expectOneNextStep(page)`). The fixtures seed the household
**The Baez Family** (slug `baez`) and set the night status through the API. Viewport 360×640.

**Cross-cutting**
- AC-0.1: On every screen below, `expectOneNextStep` passes: exactly one `primary-action`, or zero
  plus one `waiting` with an `aria-live` status, and at least one way-out control (except S0, S1,
  S10 and S13, where the way out is the primary itself).
- AC-0.2: The primary action is inside the viewport without scrolling at 360×640. On
  `screen(locked)` the way out (`locked-back`, "Back to everyone") is in the viewport too.
- AC-0.3: Every button and tile has a bounding box ≥ 56px tall, and keypad keys ≥ 64px.

**S0/S1 — join**
- AC-1.1 (setting on): a new context opens `/j/baez?code=<code>` → `screen(join)` shows the code
  in the field and `copy.s1.prefilled`, `page.url()` no longer contains `code=` within 1 s, and **no**
  join request is sent until **Join** (`primary-action`) is tapped. One tap → one of S2/S8/S9/S10
  within 3 s.
- AC-1.1b: `/j/baez?code=ABC1O0` (look-alikes) → the field is empty, no request is sent, and the
  `code=` parameter is removed.
- AC-1.1c: `/j/baez?code=<a code from a closed night>` → Join → `copy.s1.wrong`, the field is
  cleared and focused (the typed path takes over).
- AC-1.1d: the `/j/baez` response has the header `Referrer-Policy: no-referrer`.
- AC-1.2: A new context on `/j/baez` types `abc 23-4` (the valid code in a mixed format) → it joins
  without a click on **Join**.
- AC-1.3: A wrong code → `copy.s1.wrong` is visible, the field is empty and focused, and the screen
  is still `join`.
- AC-1.4: After the failure budget → `copy.s1.slow` shows the minutes from `Retry-After`, and the
  field is disabled.
- AC-1.5: A context with a valid device cookie opens `/j/baez` → the code field never renders, and
  it lands on the resolver's screen.
- AC-1.6: A context that visited `/j/baez`, then had its cookies cleared, opens `/` → the
  **Join The Baez Family** primary links to `/j/baez`. A context that never visited sees S0 with no
  primary.

**S2 — Who's watching?**
- AC-2.1: A joined phone with no current person → `screen(who)`, tiles in the order family,
  guests, **I'm new here** last.
- AC-2.2: Each tile state in §5's table shows its badge text, and a tap routes to the listed screen.
- AC-2.3: A phone with a current person that navigates to `/` never shows `screen(who)` (regression
  for the 2026-10-17 bug).
- AC-2.4: An empty household shows `copy.s2.empty` and only the **I'm new here** tile.

**S3 — PIN**
- AC-3.1: A tap on a `free`, `!has_pin` tile → `screen(pin-create)`. Typing 6 digits moves to step 2
  without a button press. Typing the same 6 → one `PUT …/people/{id}` with `{pin}` → the resolver's
  screen. The tile is now `current`.
- AC-3.2: Step 2 with different digits → `copy.s3.mismatch`, back to step 1, and no request sent.
- AC-3.3: Enter PIN with the right PIN → the night screen within 2 s, and the `copy.chip` name
  matches.
- AC-3.4: A wrong PIN → the dots clear, and `copy.s3.wrong` shows `attempts_left` from the response
  (4, 3, 2), then `copy.s3.wrongLast` at 1.
- AC-3.5: The 5th wrong PIN → `screen(locked)`. A later right PIN still shows `screen(locked)`
  (the server answers 423).
- AC-3.6: The keypad renders 0–9; the PIN input is `type="password"`-equivalent (dots) with
  `autocomplete="off"`.

**S4 — pending claim**
- AC-4.1: A tap on a `taken`, `!has_pin` tile → `screen(pending)` (waiting). Approving the claim
  through the host API → within 7 s the phone shows the night screen with no interaction.
- AC-4.2: Rejecting through the host API → within 7 s `screen(who)` with `copy.s4.rejected`.
- AC-4.3: **Pick someone else** → `screen(who)`, and the claim still appears in `GET /devices/claims`.

**S5/S6 — locked and reset**
- AC-5.1: `screen(locked)` primary **Forgot PIN**, with "We'll ask the family admin to reset it."
  under it → `POST …/forgot-pin` (202) → `screen(reset-pending)` (waiting).
- AC-5.1b: On `screen(locked)` at 360×640, **Back to everyone** (`locked-back`) and **Forgot PIN**
  are both in the viewport without scrolling. Back to everyone → `screen(who)` on /who, or the
  switch sheet's list in the sheet, with nothing asked.
- AC-5.2: Reloading on `screen(reset-pending)` returns to `screen(reset-pending)`, not `locked`
  (G2).
- AC-5.3: An admin approves through the API → within 7 s `screen(pin-create)` for that person.
  Setting a PIN → the night screen.
- AC-5.4: An admin dismisses → within 7 s `screen(locked)` with `copy.s6.dismissed`.
- AC-5.5: **Forgot PIN?** on Enter PIN → `screen(reset-pending)` with no lock.

**S7 — new guest**
- AC-7.1: **I'm new here** → `screen(new-guest)`. **Next** is disabled until there is a name and an
  emoji. Next → `screen(pin-create)`. A matching PIN → exactly one `POST /devices/me/people` → the
  night screen, with the chip showing the new name. On `/admin/people` the person is a Guest.
- AC-7.2: An existing name → `copy.s7.taken`; **That's me** → `screen(who)` with that tile focused.

**Switch / shared phone**
- AC-8.1: A phone holding A (current) and B: S11 after A votes shows **Pass to next person** as
  primary → the switch sheet lists A "Voted ✓" and B → tap B → Enter PIN → `screen(ballot)` with
  `voting-as` = B.
- AC-8.2: After everyone on the phone has voted, S11 is a waiting screen (no **Pass to next
  person**).
- AC-8.3 (PIN every switch): A current, B voted earlier tonight on this phone and C held. Switching
  A → B → A asks for a PIN on **both** switches (two `PUT …/people/{id}` requests with a `pin`);
  no switch ever succeeds without one.
- AC-8.4 (wrong PIN on switch): A current, switch to B, wrong PIN → `copy.s3.wrong` with tries
  left and `copy.s3s.still` naming A. Closing the sheet → the switch sheet, and `GET /people` still
  reports A as `current`. The chip reads "Voting as A".
- AC-8.5 (lock during switch): the 5th wrong PIN for B → `screen(locked)` for B with the primary
  **Forgot PIN** and the way out **Back to everyone** at the top. Back → the switch sheet's list
  (not `who`); closing the sheet → A's night screen, with A still `current`. B's tile on the switch sheet shows "Locked", and
  tapping it opens `screen(locked)` with no keypad.
- AC-8.6: a 429 per-device budget during a switch → `copy.s3.slow`, back to the switch sheet,
  and A is still `current`.

**Night status**
- AC-9.1 (none): no live night → `screen(no-night)` waiting. Creating a night through the API →
  within 7 s `screen(almost-ready)`.
- AC-9.2 (draft): `screen(almost-ready)` shows the shortlist count. Adding a title updates it
  within 2 s with the stream up. Opening voting → `screen(ballot)` within 2 s with **no tap**.
- AC-9.3 (voting): `screen(ballot)` primary **Done** → `screen(picks-in)` with "N of M voted",
  which updates when another person votes.
- AC-9.4 (voting closes mid-ballot): closing voting through the API while on `screen(ballot)` →
  `screen(winner)` with `copy.s10.closed`.
- AC-9.5 (revealed → tonight): `screen(winner)` → `screen(tonight)` within REVEAL_SETTLE + 7 s with
  no interaction. The primary is **Add photos**.
- AC-9.5a (tonight hierarchy): on `screen(tonight)` with photos, exactly one `primary-action` (the
  Add photos label) and it is the first control after the winner card. `getByRole("button",
  { name: "Already watched? Rate it" })` is enabled, has the `secondary` variant
  (`data-variant="secondary"`), and its computed text colour has ≥ 4.5:1 contrast against its own
  background. No element with text matching `/rate later/i` exists. Tapping it shows the star rows.
- AC-9.5b (empty album): with no photos, `getByTestId("album-empty")` is the Add photos tile and is
  the screen's only `primary-action`; its box is ≥ 160px tall and contains `copy.s13.emptyTitle`.
  Setting a file on its input starts an upload, and once a photo exists (own upload, or another
  phone's within 12 s) the tile is gone and the grid plus a normal Add photos button show.
- AC-9.5c (here tonight): with persons A (this phone) and B (another context) on a voting night,
  this phone's `getByRole("list", { name: "Here tonight" })` contains B's avatar within 2 s of B
  voting (stream up), and B's item shows the ✓ badge. The count reads "2 here · 1 voted" (or
  "Voted so far" without G8). The list has no descendant with role `button` or `link`. No text
  inside it matches any option title of the night, and the `/present` and `/voters` responses
  contain no `option_id`, `rank` or score field (assert on the JSON).
- AC-9.5d (presence without a vote, needs G8): B's phone opens the night without voting → B
  appears on A's strip within 2 s with no ✓. On `tonight`, the strip shows the same people with
  no ✓ badges.
- AC-9.6 (closed): with a rating owed → `screen(rate)` with stars as the primary; after a star
  tap → the primary is **Past movie nights**.

**Stream and sleep**
- AC-10.1: Blocking `**/stream*` → no `copy.live.reconnecting` before 10 s. Opening voting still
  reaches `screen(ballot)` within 7 s (poll fallback).
- AC-10.2: Emulating a hidden page, changing the night status, then a visible page → the screen
  matches the new status within 2 s of becoming visible.
- AC-10.3: A ballot `PUT` refused with "Voting is not open" → the phone re-resolves and shows
  `copy.stale.closed` on the new screen. No error stays on a ballot that no longer applies.

**Host and TV**
- AC-11.1: A signed-in host whose browser holds a current person, during voting → `/host` shows
  **Vote as {name}** linking to `/s/{id}`.
- AC-11.2: `/host` signed in as a host **without** admin rights shows pending claims and no PIN
  requests. An open reset request does not change anything on `/host` or the TV. The API
  answers that host's request for the reset list with 403.
- AC-11.2b: signed in as an admin, `/admin/people` lists the open request in `#pin-requests`
  with the name and device label. **Reset PIN** → confirm → the requesting phone moves from
  `screen(reset-pending)` to `screen(pin-create)` within 7 s. **Dismiss** → the phone moves to
  `screen(locked)` with `copy.s6.dismissed`. As an admin, `/host` also shows
  `copy.host.adminResets` linking to `/admin/people#pin-requests`.
- AC-11.3 (setting off, the default): a new household's `/admin/settings` shows "Include
  tonight's code in the TV QR" switched **off**. The TV lobby QR decodes to exactly
  `<origin>/j/baez` (no query), and the label is `copy.tv.scanType`.
- AC-11.3b (setting on): the admin turns it on → within 10 s the TV QR decodes to
  `<origin>/j/baez?code=<tonight's code>`, the label is `copy.tv.scan`, and the code text under it
  matches. Rotating the code on `/host` re-renders the QR with the new code.
- AC-11.3c (on, but the TV lacks the code): with the TV's `sessionStorage` cleared, the QR
  decodes to `<origin>/j/baez`, and the code-entry prompt shows. Entering the code switches to the
  `?code=` QR.
- AC-11.3d: no API response to the TV or any device contains the plaintext night code (assert
  on the JSON of `join-link`, `settings` and the session snapshot).
- AC-11.4: With a pending person claim open, the TV shows `copy.tv.help` within 10 s. With only a
  PIN reset open, it shows nothing.

**The 30-second target (manual on staging in issue #42, then automated as a timing probe)**
- AC-12.1: On a real phone, the TV QR → ballot saved in **≤ 30 s** for a first-time guest with
  the setting **on** (median of 3 runs), and recorded (target ≤ 36 s) with it off. A returning
  phone in **≤ 15 s**.
