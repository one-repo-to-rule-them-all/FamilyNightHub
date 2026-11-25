# ADR-0018: A Games tab: household-scoped party games run by a host, played from phones, shown on the TV

## Status

Accepted (2026-11-24), with the review answers recorded at the end. Slices A (jar), B (bingo, migration `0010_bingo`) and C (scattergories, migration `0011_scattergories`) built.
Numbered 0018 because 0011 is claimed by the open room-types draft (PR #24) and 0012 is unused;
that ADR is about _choosing_ a game for a night, this one is about _playing_ one, and they do not
overlap.

## Context

For Thanksgiving (and any family gathering) the family wants three small games: a Gratitude Jar,
Thanksgiving Bingo and Thanksgiving Scattergories. Everything these games need already exists:
people acting from a device with a PIN (ADR-0002, ADR-0014), a host who runs things
(`sessions:run`), household scoping in app code and RLS (ADR-0003), SSE hints with refetch
(ADR-0004) and a TV screen under `/tv`.

What does not exist is a place for activity that is **not a movie night**. Today SSE tickets, the
`session:{id}` channel and the stream route are bound to a `sessions` row, and `/tv` follows the
newest night. A jar is filled for days before anyone reveals it; bingo and scattergories happen at
a table with no movie. Forcing games into `sessions` would drag voting, shortlist, ballots and the
night code into rows that have none of them.

## Decision

### 1. A `games` table of its own, with one table set per kind

`games` is household-scoped and carries what every game shares:
`id`, `household_id`, `kind` (`gratitude_jar` | `bingo` | `scattergories`, CHECK-listed),
`title`, `status`, `config jsonb` (validated by a per-kind Pydantic model, never trusted raw),
`created_by_account_id` (composite FK to `accounts`), `created_at`, `started_at`, `ended_at`.
`status` is `draft → open → live → ended`; each kind uses the subset it needs and the transition
table lives in `domain/games/` as pure functions, like `domain/session_state.py`.

`game_players` (`game_id`, `person_id`, `joined_at`, unique per pair) is the one roster, used by
bingo and scattergories for "who's in" and by the TV lobby. Per-kind tables hang off `games` with
composite `(x_id, household_id)` FKs and `ON DELETE CASCADE` from the game:

| Slice | Tables                                     | Notes                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | `games`, `game_players`, `gratitude_notes` | `gratitude_notes`: `game_id`, `person_id` (the author), `body` (1-280 chars), `anonymous`, `reveal_position`, `revealed_at`, `hidden_at`                                                                                                                         |
| B     | `bingo_cards`                              | `game_id`, `person_id`, `squares` (25 strings, snapshotted from the pool so a later pool edit cannot change a card in play), `marked_mask` (25-bit int), `won_at`; unique (game, person)                                                                         |
| C     | `scatter_rounds`, `scatter_answers`        | round: `game_id`, `round_no`, `letter`, `categories jsonb`, `duration_seconds`, `started_at`, `ends_at`, `revealed_at`; answer: `round_id`, `person_id`, `category_index`, `text`, `host_verdict` (null / accepted / rejected); unique (round, person, category) |

Every table has `household_id NOT NULL`, `ENABLE` + `FORCE ROW LEVEL SECURITY` and the
`household_isolation` policy **in the same migration**, joins the `test_rls_coverage.py` pin and
the isolation suite (ADR-0003). Cross-household ids are 404. One Alembic migration per slice, each
a straight continuation of the chain (`0009_games_core` after `0008_platform_owner`, then
`0010_bingo`, `0011_scattergories`); the head is re-verified before each is written. The openapi
contract is regenerated in the same commit as any schema change.

Games are **not** attached to a night. A host may start a game at any time, with or without a
live night, and several can exist at once (a jar that stays open all week, a bingo round tonight).

### 2. Who may do what: no new auth path

- **Host actions** (create, open, start, end, reveal, reject an answer) need `sessions:run`: hosts
  and admins, the same people who run a night. No new permission. Because `games.created_by_account_id`
  is an account foreign key, `sessions:run` stays in `PLATFORM_DENIED` (ADR-0016) and a platform
  operator inside a household cannot create a game, for the same reason they cannot create a night.
- **Player actions** (drop a note, join, mark a square, submit an answer) go through
  `people_service.require_can_act_as`: an active, current binding to a person with a PIN, exactly
  like a ballot (ADR-0014). A host may also play as a person from their own enrolled browser.
  There is no proxy path in v1: kids without a phone play on a parent's phone as that person.
- **Reads** (list, snapshot) are open to any device or account of the household (`ViewerDb`), as
  the night snapshot is. The snapshot never holds anything not yet meant to be seen (section 4).
- **Consent gate.** Anything that stores a child's words (a note, an answer) calls
  `consent_service.require_household_consent` like every other path that stores a child's data
  (ADR-0017). Reading and hosting do not.
- **Person lifecycle.** Merge repoints the new tables (collisions go the target's way, as in
  the merge table in `03-backend.md`: the source's bingo card and answers are dropped where the
  target has one, notes always move). Person delete erases their notes, cards, answers and
  roster rows. The export (`export_service`) and its pinned table catalog gain the new tables.
  Both are tested in the slice that adds the table.

### 3. Live state over the existing SSE channel

ADR-0004's contract is kept: **events are hints, the snapshot is the truth, no payload carries
game content.** The mechanism is generalised, not forked:

- A second channel `game:{game_id}` beside `session:{id}`, same publisher (best-effort,
  after-commit, per-channel `version` counter), same registry guard (`app/realtime/events.py`
  gains `GAME_CHANGED`: status, config, roster or round changed; and `GAME_ACTIVITY`: a note was
  dropped, a square marked, an answer submitted, so screens refetch counts and standings). An
  unregistered type still raises.
- Tickets carry a `scope` (`session` or `game`) and the id; the stream refuses a ticket minted for
  another scope or id. `POST /sse-tickets` takes exactly one of `session_id` or `game_id`;
  `GET /games/{id}/stream?ticket=` is a sibling of the night stream, sharing its streaming
  response class (heartbeat, 30-minute cap, shielded cleanup, `degraded` frame).
- Phones and the TV use one `useLiveGame(id)` hook, the twin of `useLiveSession`: same backoff,
  same `data-live="ready|reconnecting"`, polling every 5 s only while the stream is down.

**The timer is not an SSE event.** A tick per second per client would be the noisiest traffic in
the system for no gain, and a missed tick desyncs the clock. Scattergories stores a server
`ends_at`; the snapshot carries `ends_at` and `server_now`, clients count down locally against
that offset, and the only events are start and "time's up / revealed". The server is the clock:
an answer arriving after `ends_at` plus a 2-second grace is 409, and the round's _effective_
state is derived from `ends_at` on read (the same lazy-settle idea as `revealed → tonight`),
so no worker or timer job is needed and a crashed process cannot leave a round running forever.

### 4. What each game does

**Gratitude Jar (slice A).** `open`: any person drops notes (`anonymous` is the author's choice;
`config.allow_anonymous`, default true). Authors may delete their own note until it is revealed.
The host moves the jar to `live` ("Start reveal"): the server shuffles the unrevealed notes with
a seeded RNG (`secrets.randbits(64)` stored on the game, test-pinnable with `X-FNH-Test-Seed`
like the voting tie-break) and writes `reveal_position`. Each **Next note** sets `revealed_at` on
the next position and publishes `GAME_CHANGED`. **Unrevealed note text never leaves the server
except to its own author and to a host's moderation list**: the snapshot returns the revealed notes, a count of the rest and the
caller's own notes. An anonymous note never exposes its author to anyone, the host included
(the `person_id` column exists for the author's own delete and for person erasure only). The host
can hide a note once it is on screen (`hidden_at`), which removes it from every snapshot;
the host (`sessions:run`) can read unrevealed note text in a moderation list (`GET /games/{id}/jar/moderation`) and hide a note before it is shown, though never the author of an anonymous one. A note that is hidden stays in the table
for the export and is erased with its author.

**Thanksgiving Bingo (slice B).** Joining generates the card: 24 squares drawn without
replacement from a themed pool in `domain/games/bingo_pool.py` plus a free centre
(`config.free_center`, default true), shuffled by a server-side RNG; the card is stored
as text. `config.win_mode` is `line` (any row, column or diagonal) or `blackout`. Marking is
`PUT/DELETE /games/{id}/bingo/mark/{index}` for the caller's own card: it locks the card row,
flips a bit in `marked_mask`, and a pure function checks the 12 line masks (or the full mask).
**There is no "buzz" button**: marking the square that completes the pattern is the win, decided
under the game row's `FOR UPDATE` lock, so two phones completing at once yield one first winner
and one `won_at` order. Marks are an honour-system claim that the thing happened; nothing
verifies them, and the host can end the round at any time. The first win ends the round by
default (`config.end_on_first_win`; with false it keeps going and records the finishing order).
The snapshot gives the TV each player's avatar and "squares from bingo" (the fewest unmarked
squares in any one pattern), never which squares. Other players' cards are not readable.

**Thanksgiving Scattergories (slice C).** The host starts a round: a random letter from a set
that excludes Q, U, V, X, Y and Z, N categories drawn from a themed list in
`domain/games/scatter_categories.py` (the host may edit the draw before starting), and a duration.
Players submit one answer per category; they can replace theirs until `ends_at`. **Answers are
visible to nobody, the host included, until reveal.** The host reveals after time is up (or ends
early); reveal sets `revealed_at` and freezes answers. Scoring is **derived on read** by a pure
function and never stored, so a host override cannot leave a stale score: an answer is _valid_
if it starts with the round's letter after normalisation (casefold, accents and punctuation
stripped, leading "a/an/the" dropped, whitespace collapsed) and has not been rejected; a valid
answer that is unique among valid answers in that category across players scores 1, duplicates
and invalid answers score 0. The host can reject or re-accept an answer after reveal
(`host_verdict`), which is the whole of the manual challenge step; a player-initiated
challenge/accept vote is deferred. The leaderboard sums rounds; a game can run several rounds.

### 5. Frontend

- Phone: a fourth tab, **Games**, in `GuestShell`'s bottom nav (`/games`, `/games/[game]`),
  with the existing 56 px tap-target rule. The portal gets **Games** in the nav for admins and
  hosts, and `/host/games/[game]` is the host's control surface per kind.
- TV: `/tv/games/[game]`. The existing `/tv` keeps following the live night; if there is none it
  falls back to a game that is `live`, and the host can always open `/tv/games/[game]` directly
  ("Open TV window" reuses `use-as-tv` with the game's path). A night wins over a game on
  `/tv` because the night's QR/code flow is time-critical.
- Design: ADR-0008 tokens and the existing `Button`, `Card`, `ModalDialog`, `DataTable`. Big
  emoji/avatar tiles, no text-only controls on a phone, `aria-pressed` on bingo squares (state
  is never colour alone: a mark is a check glyph plus the colour), visible focus, 4.5:1 contrast,
  `prefers-reduced-motion` honoured for reveal animations, an `aria-live` region announcing
  reveals and wins. The cinema accent is reserved for the one primary action and for a winner.

## Alternatives considered

**Model games as a kind of `sessions` row** (the direction ADR-0011 takes for dinner and
game-night _votes_). Rejected here: a played game has no shortlist, ballots or tally, and
sessions carry a night code, a lifecycle and photo/rating rules that would all need to be
special-cased away. Games are a sibling, with the shared infrastructure (SSE, scoping, auth)
reused rather than the table.

**One `game_events` log table with generic payloads.** Rejected: bingo's win detection and
scattergories' uniqueness scoring are queries over typed state, and a jsonb log turns every
integrity rule into application code the database cannot back up with a constraint.

**Timer ticks over SSE, or a server-side timer job.** Rejected (section 3): the ticks are noise,
and a job adds a failure mode (a round that never closes if the worker is down) that deriving
state from `ends_at` does not have.

**A manual "Bingo!" buzz that the server validates.** Rejected: it adds a false-claim state and
an argument at the table. Automatic detection on the completing mark is simpler and cannot be
wrong in the player's favour.

**Reusing the voting `ballot_ranks` for scattergories answers.** Rejected: they are free text
per category, not a ranking of options.

## Consequences

- One generalisation of the SSE layer (scope on tickets, a second channel and stream route) with
  its own unit and stream tests; the night stream's behaviour does not change.
- Six new household tables across three migrations, each pinned by the RLS coverage test and
  the isolation suite; export, merge and person-delete each need an explicit rule per table.
- Free text from children is stored: consent-gated, length-capped, host-hideable, erasable,
  exportable. There is no profanity filter in v1 (the host-hide control is the mitigation);
  noted as a known gap.
- The bingo marks are an honour system. That is the right trade for a family game and wrong for
  anything with a prize worth cheating for; the ADR says so rather than hiding it.
- Scattergories uniqueness is exact-after-normalisation: "mashed potatoes" and "mashed potato"
  do not collide, so the host's reject/accept override is load-bearing, not a nicety.
- Test posture: pure `domain/games/` modules at 100% with Hypothesis properties (card is a
  permutation of distinct pool squares; win detection agrees with a brute-force oracle; scoring
  is independent of answer order); real-Postgres integration tests per game plus cross-household
  isolation; a Playwright spec per game that waits on `data-live="ready"` and asserts server text.

## What is deferred

- Player-initiated challenge/accept for scattergories; fuzzy or plural-aware matching.
- Household-editable bingo squares and scattergories categories (the lists ship in code).
- Bingo cards for people without a phone (host proxy marking), and per-person jar notes on the
  host's phone before reveal.
- A profanity filter, and push notifications for "your turn" or "round started".
- Seasonal packs beyond Thanksgiving; the pools are plain Python data so a second pack is a
  one-file change.
- Slices B and C are built after A merges; this ADR fixes their shape, not their code.

## Review answers (2026-11-24)

1. Hosting reuses `sessions:run`; no `games:run`.
2. The host **can** pre-read unrevealed jar notes, to pre-moderate kids' notes (this reverses the
   draft's default). Anonymous notes still never expose their author, even there.
3. A live night always wins `/tv`; otherwise a live game.
4. Scattergories uses a local countdown against the server's `ends_at`; no tick events.

Games use the household's existing people, devices and accounts; no second roster or identity.

## Amendment 2026-11-25: owner feedback from staging

Appended after the owner hand-tested the jar and bingo on staging. Accepted text above is not
edited. Where this amendment changes a rule, it says which one; everything else stands. This is a
design only: it fixes the shape of three build items (A bingo, B jar, C scattergories) so three
builders can start from it. Questions for the owner are marked **OPEN**. Each has a recommended
default, and a builder uses that default unless the owner answers otherwise.

### Context

- **Bingo.** "This year let's just go with normal bingo." Thanksgiving bingo (honour-system marks
  of things that happened) stays, untouched, for next year. The night needs classic bingo: the
  host draws numbers at random, people tap the ones called, someone says "bingo", the host checks
  it. This partly reverses the "no buzz, server validates" rejection in _Alternatives considered_:
  for classic bingo the server **does** verify a claim, because there is now a called set to verify
  against. Thanksgiving mode is unchanged.
- **Jar.** A manual "Next note" walkthrough is slow. Once the host starts it, notes should cycle
  by themselves on the TV and on phones that open the game, in random order, repeating, with
  similar notes next to each other.
- **Scattergories.** The host should not read every answer. The server already scores a wrong
  first letter or a duplicate as 0; the host should only see what needs a human.

Two other sessions are editing the frontend game screens and `/tv` routing, and adding migration
`0012_tv_target`, while this is written. Nothing here assumes their result beyond the migration
number.

### A. Classic bingo as a second mode

**Decision.**

1. **Mode lives in config.** `config.mode` is `thanksgiving` | `classic`, validated by the bingo
   config model, fixed at creation. A stored config with no `mode` is `thanksgiving`. The API
   default is `thanksgiving` so existing callers and tests do not change; the host's create form
   preselects **classic** this year (a frontend default, not a server one). `win_mode`
   (`line` | `blackout`), `free_center` and `end_on_first_win` keep their meaning and defaults for
   both modes. Config is jsonb, so the mode needs no migration.
2. **The card.** Classic cards reuse `bingo_cards` unchanged: `squares` holds 25 strings in
   row-major order, here the decimal number as text, with `FREE` at index 12 when `free_center`;
   `marked_mask` is the 25-bit mask. Column `c` (index `% 5`) is B, I, N, G or O, holding 5
   distinct numbers from 1-15, 16-30, 31-45, 46-60 and 61-75 respectively (24 numbers plus the
   free centre; without `free_center`, the N column has 5). New pure module
   `domain/games/bingo_classic.py`, so Thanksgiving's `bingo.py` is not touched; it keeps
   providing the masks, `toggle_mark`, `has_win` and `squares_from_bingo`:
   - `generate_classic_card(rng, free_center) -> list[str]`;
   - `letter_for(value)` and `label(value)` ("B7", "G52");
   - `call_order(seed) -> list[int]`: 1-75 shuffled by `random.Random(seed)`;
   - `called_mask(squares, called: set[int]) -> int`: bit `i` set when `squares[i]` is `FREE` or
     its number is in `called`. A win check is `bingo.has_win(called_mask(...), win_mode)`.
3. **Drawing is seeded.** `games.reveal_seed` (existing column, used by the jar) is set when a
   classic game is **opened**, to `secrets.randbits(64)` or to the `X-FNH-Test-Seed` seed in
   `ENVIRONMENT=test` (open is idempotent and keeps an existing seed; join needs the seed before
   the game starts). The `n`-th call is `call_order(seed)[n]`. No repeat is true by construction, a
   test can pin a whole game, and a unique index backs it. The seed never appears in a snapshot,
   so nobody can read ahead.
4. **Marking is limited to called values.** For `classic`, `PUT .../bingo/mark/{index}` is 409
   ("That number hasn't been called.") unless the square is `FREE` or its number is called.
   Unmarking is always allowed. The completing mark no longer wins (the Thanksgiving rule does not
   apply in classic); a win is recorded only by a host check.
5. **Claims are verbal; the host checks.** No in-app "Bingo!" request in v1 (least build; it
   matches "verbally plus a host button"). The host panel lists the players, each with **Check
   bingo**. `POST /games/{id}/bingo/check` with `{person_id}` (host, `sessions:run`):
   - computes `called_mask` from the card's snapshotted `squares` and the called set, **not** from
     `marked_mask`: a player who forgot to tap still wins what they have, and a wrong tap cannot win;
   - returns `{valid, win_mode, pattern: [indices] | null, missing: int}` (`pattern` is the first
     complete line, or all 25, so the host can read it out; `missing` is `squares_from_bingo` over
     the called mask);
   - **invalid** leaves the game unchanged (no status change, no `won_at`, no SSE event) and is
     audited; a false claim never stops the game;
   - **valid** sets `won_at = clock_timestamp()` if unset (checking a winner again is idempotent),
     computes `finish_place` as today, and with `end_on_first_win` ends the game in the same
     transaction, all under the game row's `FOR UPDATE`, the same lock order as `set_mark`.
     Only a `live` game can be checked; a person with no card is 404.
6. **The called list is public.** The TV shows it, so it is in the ordinary snapshot:
   `bingo.mode`, `bingo.calls` (`[{seq, value, label}]` in call order) and `bingo.last_call`.
   Future calls and the seed are never in it. In classic, each player's `squares_from_bingo` is
   computed from the called mask. Card squares and marks stay readable only by the cardholder's
   phone via `/bingo/mine`.

**Data model.** One table, migration **`0013_bingo_calls`** (down revision `0012_tv_target`; the
head is re-verified before it is written):

| Table         | Columns                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bingo_calls` | `id`, `game_id`, `household_id` NOT NULL, `seq` smallint (0-based), `value` smallint CHECK 1-75, `called_at timestamptz`; composite FK `(game_id, household_id)` to `games` `ON DELETE CASCADE`; unique `(game_id, seq)` and unique `(game_id, value)` |

`ENABLE` + `FORCE ROW LEVEL SECURITY` and the `household_isolation` policy are in the same
migration; the table joins the `test_rls_coverage.py` pin and the isolation suite (ADR-0003).
Cross-household is 404. The openapi contract is regenerated in the same commit.

**API changes.** Thanksgiving games reject the new calls with 409 "This is a Thanksgiving round."

- `POST /games/{id}/bingo/draw` (host). Body `{expected_seq}`: the number of calls the host's screen
  showed. A different server count is 409 with the current snapshot, so a double tap or a second
  host window cannot draw twice. Locks the game row `FOR UPDATE`, inserts the next call, returns
  it. 409 unless `live`; 409 "Every number has been called." at 75. Publishes `GAME_CHANGED`.
- `POST /games/{id}/bingo/check` as above.
- Mark behaviour as in point 4; `open` stores the seed; `join` calls `generate_classic_card` with
  `random.Random(seed ^ person.int)` as the existing join does.
- Not in v1: undo of the last call, a chosen-number call.

**State machine.** `draft → open → live → ended` is unchanged. Classic adds the draw gate (`live`)
and moves seed creation to `open`. A valid check ends the game when `end_on_first_win` (default
true; unticked at creation, play goes on and `finish_place` follows `won_at`).

**Audit and events.** `game.bingo_called` (`{seq, value}`), `game.bingo_checked`
(`{person_id, valid}`), and the existing `game.ended`. `GAME_CHANGED` on a draw and on a valid
check; `GAME_ACTIVITY` on a mark as today; nothing on an invalid check.

**Frontend at a glance.**

- Host (`bingo-host.tsx`): mode picker on create (classic preselected). In a live classic round, a
  large **Draw** button (disabled while a request is in flight), the last call in huge type
  ("B 7"), the called board (5 x 15 B-I-N-G-O grid), the called list in order, and per-player
  **Check bingo** with the result inline ("Valid: top row" / "Not yet: 2 away"; invalid is a quiet
  message, not an error).
- Phone (`bingo-screen.tsx`): last call and the last five above the card; an uncalled square is
  visibly inactive (`aria-disabled`, not just dimmed) and a tap says why; called squares are
  `aria-pressed` with a check glyph as today. No Bingo button; people say it aloud.
- TV (`tv-bingo.tsx`): last call very large with its letter, the called board, the last five
  calls, players as avatars, and the winner once recorded. No per-player progress in classic (it
  spoils the suspense); the host panel has it. `aria-live` announces each call and the winner.

**Person lifecycle.** `bingo_calls` has no `person_id`, so merge and person delete leave it alone;
it goes with its game (cascade, including Start fresh). The export catalog gains `bingo_calls`.
Card merge rules are unchanged.

**Test plan** (targeted runs only).

- Pure `bingo_classic.py` at 100% with Hypothesis: a card is 24 distinct in-range numbers per
  column rule plus FREE; `call_order(seed)` is a permutation of 1-75, stable per seed; `called_mask`
  with `has_win` agrees with a brute-force oracle.
- Integration (real Postgres): 75 draws never repeat; a stale `expected_seq` is 409 and inserts
  nothing; two simultaneous draws give consecutive `seq`; a mark on an uncalled value is 409 and
  an unmark works; a false check leaves status, `won_at` and event count unchanged; a true check
  records `won_at`, is idempotent and ends the game when configured; a card the player forgot to
  tap still checks valid; Thanksgiving tests pass untouched and Thanksgiving rejects draw/check; a
  pinned `X-FNH-Test-Seed` reproduces a whole game; RLS and cross-household 404; export lists the table.
- Frontend: component tests for the called board and inactive square; one Playwright spec (host
  draws, phone taps, host checks) waiting on `data-live="ready"`.

**Deferred.** Phone-side "Bingo!" request; auto-detecting a claim; undo last call; chosen-number
call; audio calls; 90-ball cards; custom patterns (four corners, X).

**OPEN (owner).**

- **A1.** Should a valid check end the game at once (recommended, `end_on_first_win` true), or
  should the host choose "keep playing for second place" each time?
- **A2.** Is **line** the right default win mode this year, or blackout? (Recommended: line.)
- **A3.** Undo for a mistaken Draw? (Recommended: not in v1; the number is just called.)

### B. Gratitude Jar auto-cycle

**Decision.** This changes two rules of section 4 for jars: "Each **Next note** sets
`revealed_at` on the next position", and revealed meaning _one at a time_. The rule that
unrevealed text never leaves the server is kept; what changes is when a note counts as revealed.

1. **Revealed means "in the cycle".** In cycle mode, **Start reveal** sets `revealed_at = now()` on
   every unhidden note in one transaction and the jar goes `open → live` (it already closes to
   new notes there). From then the snapshot carries all those notes' text, because they are on
   show. Notes hidden before start never get `revealed_at` and never leave the server. The host's
   moderation list before start is the only pre-start reading of text, and **Start is the point
   of no return for exposure**; the host UI says so. Hiding after start removes a note from every
   snapshot at once.
2. **Clients drive timing from a server anchor.** No tick events (section 3 stands). The snapshot's
   `cycle` is `{anchor_at, server_now, dwell_seconds, paused_index | null}` and `notes` are ordered
   by `reveal_position`. A client computes `offset = server_now - Date.now()` per snapshot and
   shows index `floor((now + offset - anchor_at) / dwell) mod count`, or `paused_index` while
   paused. A phone opened mid-cycle catches up by itself. The arithmetic is a pure
   `jar.cycle_index(now, anchor_at, dwell_seconds, count, paused_index)` with a TypeScript twin,
   both tested against one shared JSON vector file.
3. **Order and repeat.** The server fixes one order at start and clients loop it, so laps repeat the
   same order in v1. **Reshuffle** re-orders with a new seed and re-anchors.
4. **Dwell.** `config.cycle_seconds`, 5-60, default 12, set at creation, flat (not scaled by
   length). A phone can **Hold** a note locally; nothing is sent.
5. **Similar notes sit together, no AI call.** Pure `jar.group_order(notes: [(id, body)], seed)
-> [id]`, run at start and on Reshuffle: sort by id first (so insertion and read order cannot
   matter); `keywords(body)` = casefold, strip accents and punctuation, split, drop a fixed
   stopword list (articles, pronouns, "my", "for", "that", "very", "thankful", "grateful",
   "thanks", "thank", "appreciate" and similar, fixed in code), light stemmer (plural `-s`, `-es`,
   `-ies`→`y`, `-ing`, `-ed` on words of five or more letters), keep words of three or more
   letters. Two notes are _similar_ when both keyword sets are non-empty and they share at least
   two keywords **or** have Jaccard similarity of at least 0.5 ("family" / "my family" group;
   "family" / "family dinner" group; "dad" / "my dad's cooking" do not). Groups are connected
   components, capped at 6 notes (the rest start a new group) so a loose chain does not make a long
   dull run. Within a group notes are shuffled with the seed; groups are shuffled with the seed over
   their smallest id. The output is a permutation of the input. `reveal_position` stores it.
6. **Host controls.** **Start**, **Pause** / **Resume**, **Reshuffle**, **Hide** a note (effective
   immediately everywhere) and **End**. There is no Next note in cycle mode. Pause stores the
   index being shown; Resume re-anchors so that note gets a full dwell.
7. **Manual mode stays.** `config.reveal_mode` is `cycle` | `manual`, written explicitly on create
   (form and API default `cycle`). A stored config with no key is `manual`, so an existing jar
   behaves as built. Pause, Resume and Reshuffle are 409 on manual jars and Next note is 409 on
   cycle jars.

**Data model.** Migration **`0014_jar_cycle`**, after `0013_bingo_calls` (re-verify the head):
`games.cycle_anchor_at timestamptz NULL` and `games.cycle_paused_index integer NULL` (CHECK `>= 0`),
null for every non-jar game and manual jar. No new table, so no new RLS policy. The state is on
the row, not in `config`, because it changes after creation.

**API changes.**

- `POST /games/{id}/jar/start-reveal` (existing) in cycle mode: reveals every unhidden note, writes
  the grouped `reveal_position`, `reveal_seed`, `cycle_anchor_at = now()`, `status = 'live'`. 409 if
  already live or empty, as today.
- New host calls: `POST .../jar/pause`, `.../jar/resume`, `.../jar/reshuffle` (pausing a paused jar
  is a no-op). Hide is unchanged; because it changes the list length a cycling screen may jump on
  its next snapshot, which is accepted over extra re-anchor logic.
- Snapshot `jar` gains `mode`, `cycle` (null for manual or not started) and `notes` ordered by
  `reveal_position`; the unrevealed count and the caller's own notes are as today.
- `GAME_CHANGED` on start, pause, resume, reshuffle and hide. Nothing per tick or lap.

**State machine.** Statuses unchanged. Inside `live`, _cycling_ and _paused_ are derived from
`cycle_paused_index IS NULL`; they are not statuses and need only `jar.can_pause` / `can_resume`
helpers.

**Audit.** `game.reveal_started` (note count), `game.jar_paused`, `game.jar_resumed`,
`game.jar_reshuffled`, `game.note_hidden`, `game.ended`; `game.note_revealed` only in manual mode.

**Frontend at a glance.** TV: one big note, a soft cross-fade (instant under
`prefers-reduced-motion`), author name unless anonymous, "note 4 of 17", a calm "Paused" chip; not
`aria-live` (a note every 12 seconds would be noise). Phone: the same cycling card with a local
**Hold**, own notes below as today. Host: Start (with the exposure warning), Pause/Resume,
Reshuffle, note list with Hide, End, Open on the TV.

**Test plan.**

- Pure `jar.py` at 100% with Hypothesis: `group_order` is a permutation, independent of input
  order, stable per seed, groups contiguous, cap holds; table vectors for stemming and stopwords
  ("family"/"my family", "dinner"/"dinners", "mom"/"dad" apart); `cycle_index` wraps, honours
  pause, and equals the TS twin on the shared vectors.
- Integration: start reveals every unhidden note once and leaves hidden ones unreadable by a
  guest; a guest snapshot before start never holds anyone else's text; pause/resume/reshuffle move
  anchor and index as specified; hide drops a note from the next snapshot; Next note is 409 in
  cycle mode and existing manual tests pass unchanged; a config with no `reveal_mode` is manual;
  an anonymous author is still never exposed; export and erase unchanged.
- Frontend: fake-timer test of the cycling component against the shared vectors; one Playwright
  spec that starts a jar and sees two different notes with no click.

**Deferred.** Per-lap reshuffle; dwell scaled by length; changing dwell after start; semantic
grouping by embeddings or an AI call (out of v1 on cost and because a child's words would go to a
third party); a "favourite" tap.

**OPEN (owner).**

- **B1.** Is "every unhidden note becomes visible when the host presses Start" acceptable? It gives
  up the one-at-a-time surprise; pre-read and Hide are the safeguard. (Recommended: yes.)
- **B2.** Show author names on cycling notes when not anonymous? (Recommended: yes.)
- **B3.** 12 seconds a note, same on TV and phones? (Configurable 5-60 at creation.)

### C. Scattergories: validate early, review only what needs a human

**Decision.** The server stays the authority on scoring. Three changes: a phone-side check, a
stronger near-duplicate rule, and a host review that lists only cases needing a decision. This
replaces section 4's "uniqueness is exact-after-normalisation" and the Consequences bullet saying
"mashed potatoes" and "mashed potato" do not collide.

1. **Phone validation (convenience only).** The answer field shows "Must start with P" as soon as
   the first letter is wrong, and the phone does not send an answer that fails (it stays in the
   field marked "won't count"). A TypeScript port of `scatter.normalize` does the check; both are run
   against one shared JSON vector file (letters, accents, leading "a/an/the", punctuation, `Ñ`,
   empty). The server is unchanged here: it still accepts the text and scores it 0, so a direct API
   call or an old client cannot break a round.
2. **Two keys, one pure rule** in `domain/games/scatter.py`: `normalize` is today's strict key.
   New `dedupe_key(text)` = `normalize`, then each word folded: `ies`→`y` (five or more letters), a
   final `es` after `s`, `x`, `z`, `ch`, `sh` removed, otherwise a final `s` removed when the word
   has four or more letters and does not end in `ss`, `us` or `is`. "mashed potatoes", "mashed
   potato" and "Mashed Potato!" share a key; "bus", "glass" and "lens" are left alone. Scoring
   groups valid answers by `dedupe_key`: same key in a category scores 0, otherwise 1. **A host
   _accept_ means "this is its own answer"**: an accepted answer is grouped by its strict
   `normalize` key instead, so accepting "potato" against "potatoes" gives both 1 while an exact
   duplicate still collides. `rejected` is unchanged, and accepting a wrong-letter answer does not
   rescue it (as built). No new verdict value, so no migration. Scores are derived on read, so
   already revealed rounds rescore on next read; that is intended.
3. **Possible matches the rule does not merge.** Two valid answers in a category whose
   `dedupe_key`s differ by Levenshtein distance 1, on keys of 6 or more characters ("pumkin pie" /
   "pumpkin pie"), score as written and are only surfaced for review.
4. **What needs a decision.** Pure `scatter.review(answers, verdicts, *, letter)` partitions every
   answer in a revealed round exactly once:
   - **needs_decision**: _near_duplicate_ (merged only by `dedupe_key`, or a typo match; choices
     **Count as the same** and **Count separately**, the latter accepting the answers) and _short_
     (a valid answer with fewer than 3 letters after `normalize`, spaces excluded; keep or
     **Reject**);
   - **informational** (collapsed, no action needed): _duplicate_ (identical strict keys, both 0)
     and _auto_rejected_letter_ (wrong first letter, 0, not overridable);
   - **auto_accepted**: everything else, as a count.
     **What cannot be automated** is category fit ("Pumpkin" under "Things in a kitchen"): no list or
     model judges it in v1. The screen says so and keeps **Show all answers**, one tap away, with the
     existing per-answer reject. The host remains the judge of fit, but only when they choose to look.
5. **Accept the rest** writes nothing: unreviewed answers already count (a null verdict is valid).
   It closes the review and goes on to the leaderboard or next round. Scores update live on the TV
   as the host decides, since each verdict already publishes `GAME_CHANGED`.

**Data model.** None: no migration, column or verdict value.

**API changes.**

- `GET /games/{id}/scatter/rounds/{round_no}/review` (host, `sessions:run`; 409 before reveal):
  `{round_no, letter, needs_decision: [{kind, category_index, category, answers: [{person_id, name,
text, verdict, points}]}], informational: [...], auto_accepted_count, total}`. Answers are identified
  by the same `(round, person_id, category_index)` the existing `PUT .../verdict` uses; there is no
  new write endpoint. Computed from the same rows as scoring, never stored.
- Revealed scores use the new key; the leaderboard shape is unchanged. Phone: no API change.

**State machine.** None. `running → closed → revealed` and "a round starts only after the previous
is revealed" are unchanged; review is a view over a revealed round.

**Audit and events.** `game.answer_verdict` as built. Viewing and Accept the rest are not audited.

**Frontend at a glance.** After **Reveal** the host sees short cards, each with the answers side by
side and one or two plain buttons, a collapsed "Wrong letter and exact duplicates (3)", "N answers
accepted automatically", **Show all answers** and **Accept the rest**. On the phone the field
validates inline, keeps the 56 px tap rule, and the message is text, not colour alone.

**Test plan.**

- Pure `scatter.py` at 100% with Hypothesis: `dedupe_key` is idempotent and a function of
  `normalize` only; singular/plural pairs merge and non-pairs ("bus", "glass", "lens", "pies" vs
  "pie" per the table) behave as specified; scoring is independent of answer and person order;
  accept separates near-duplicates and never exact ones; a wrong letter is never in
  `needs_decision`; `review` puts every answer in exactly one bucket and buckets sum to the total; the
  typo rule fires only for keys of 6+ characters at distance 1.
- Shared normalise vector file used by the Python and TS tests.
- Integration: `GET review` is 403 for a guest and 409 before reveal; a plural pair scores 0 and
  accepting one makes both 1; a typo pair scores 1 each and appears in `needs_decision`; review
  publishes no event; existing scoring tests changed by the plural rule are updated and named in
  the commit; cross-household 404.
- Frontend: component tests for the phone hint and the review buckets; the existing scattergories
  Playwright spec still passes.

**Deferred.** A model or list judging category fit; player challenge votes (as above); stemming
beyond plurals; a persisted "reviewed" flag that holds the TV on a "scoring" screen (needs a
column); host-editable accepted-answer lists.

**OPEN (owner).**

- **C1.** Should the TV show scores the moment the host reveals (recommended, simplest), or wait on
  "the host is checking answers" until **Accept the rest**? The second costs a column and a
  migration (`reviewed_at`).
- **C2.** Is auto-merging plurals as duplicates what the family wants? "potato" versus "potatoes"
  is exactly what people argue about. (Recommended: yes, with the per-answer override above.)

### Consequences of the amendment

- One new table and one two-column change to `games`, in two migrations; none for scattergories.
  Thanksgiving bingo and manual jars keep working because an absent config key means the old
  behaviour.
- Classic bingo verifies claims, so the honour-system consequence applies only to Thanksgiving mode.
- The jar gives up one-at-a-time reveal for cycling, and text exposure moves to the Start button.
- Scattergories scores for already revealed rounds can change on read after the dedupe rule ships.
- Test posture is as in the main ADR: pure modules at 100% with properties, real-Postgres
  integration, targeted runs only (CI is disabled, so deploy by hand).

### Build order and file ownership

Three builders (**A** bingo, **B** jar, **C** scattergories) work in parallel. Merge order is C,
then A, then B: C touches no schema, and the migrations chain (`0013_bingo_calls` before
`0014_jar_cycle`); whoever merges second re-verifies the head and renumbers if needed.

|                     | Owns (backend)                                                                                                                                                                                 | Owns (frontend)                                            | Notes                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **C** scattergories | `domain/games/scatter.py`, `services/scatter_service.py`, `api/v1/games_scatter.py`, scatter tests, shared normalise vectors                                                                   | scattergories phone screen, host reveal/review, TV scatter | No migration. Updates the 03-backend Scattergories bullet.                                                    |
| **A** bingo         | new `domain/games/bingo_classic.py`, the `# ---- Thanksgiving Bingo ----` section of `services/games_service.py`, bingo routes in `api/v1/games.py`, migration `0013_bingo_calls`, bingo tests | `bingo-screen.tsx`, `bingo-host.tsx`, `tv-bingo.tsx`       | Does not edit `domain/games/bingo.py`. Adds `bingo_calls` to the export catalog, RLS pin and isolation suite. |
| **B** jar           | `domain/games/jar.py`, the jar section of `services/games_service.py` (above the bingo marker), jar routes in `api/v1/games.py`, migration `0014_jar_cycle`, jar tests, shared cycle vectors   | `jar-screen.tsx`, jar host controls, TV jar view           | Put new route handlers in clearly separated blocks so A and B do not conflict in `games.py`.                  |

Conflict-prone files: `api/v1/games.py` and `services/games_service.py` (A and B edit different
sections; imports add-only; rebase before merging), the config models (add-only: A adds `mode`, B
adds `reveal_mode` and `cycle_seconds`), the regenerated openapi contract (regenerate after each
rebase, never hand-merge), and `03-backend.md`, `04-frontend.md`, `05-data.md` (each builder edits
only its own game's paragraph). Frontend builders start after the games-layout and TV-routing
sessions merge, since both rework the screens named above; domain, service, API and migration work
can start now from this amendment.

### Questions for the owner (summary)

A1 end the game on a valid check or keep playing; A2 line or blackout as default; A3 undo of a
mistaken draw; B1 everything visible on Start; B2 author names on cycling notes; B3 12 s dwell;
C1 TV waits for review or not; C2 auto-merge plurals as duplicates.

---

## Amendment 2026-11-25: the paired TV follows the host (`/tv`, "Show on TV")

<!-- Appended section: written by the games-tv-unify session; the rest of this ADR is untouched. -->

**Context.** Hand-testing on staging showed that the paired TV sat on `/tv` and never moved to a
game, and that "Open on the TV" opened a _new_ tab on `/tv/games/{id}` instead of using the TV the
household had already paired. The TV is one screen the host drives; it should not need a second
window per game.

**Decision.**

1. **A household "TV target".** One row at most per household in `household_tv_target`
   (migration `0012_tv_target`: `household_id` primary key, `game_id` with a composite
   `(game_id, household_id)` FK to `games` `ON DELETE CASCADE`, `set_by_account_id`, `updated_at`;
   FORCE RLS + `household_isolation` in the same migration, ADR-0003). It points at the game a host
   sent to the TV. No row means nothing was sent.
2. **API.** `GET /games/tv-target` (any device or account) returns `{game_id}`;
   `PUT /games/tv-target {game_id | null}` (`sessions:run`, CSRF) sets it, `null` clears it.
   Another household's game is 404; an ended game is 409. Audit: `game.shown_on_tv`.
   `GET` returns `null` once the sent game has `ended`, so the TV leaves on its own and there is
   nothing to clean up.
3. **Transport: polling the snapshot, no new event.** The TV already polls its night and games list
   every few seconds (`POLL_MS`); it now polls `GET /games/tv-target` the same way. This is the
   least invasive option: no new channel, no ticket for a TV that has no game id yet, and
   no event to miss (events stay hints and the snapshot is the truth, ADR-0004). A push hint on a
   household channel can be added later without changing the API.
4. **What `/tv` follows, in order:** the game a host sent to the TV; else a live night
   (`draft`/`voting`/`revealed`/`tonight`); else any `open` or `live` game; else the home screen.
   Screens that are already open follow too: `/tv/games/{id}` leaves when the host sends another
   game, presses **Back to QR**, or the game ends (only if the host had sent it: a game screen
   opened by hand stays put); `/tv/{night}` moves to a game the host sends.
5. **Host UI.** Each game's host screen has **Show on TV** / **Back to QR** (replacing the
   "Open on the TV" link). It only writes the target; the TV is a different device.
6. **Owner panel.** Creating a game opens its control page in a named new tab (`fnh-game`), opened
   synchronously in the click so popup blockers allow it, with a plain link when blocked; the
   hub tab stays on `/host/games`.

**Consequences.** Review answer 3 ("a live night always wins `/tv`; otherwise a live game") now
reads: _a game the host sent beats a night; then a night; then any open or live game_. **Back to
QR** returns the TV to whatever it would show with nothing sent: with a night in progress that is
the night's QR screen; with no night but an open or live game, the TV settles on that game again.
The target is not exported (it is a transient screen pointer, not household content) and is
removed with its game (cascade, so person delete and Start fresh need no extra code).

---

## Amendment 2026-11-26: Lotería

<!-- Appended section: written by the games-loteria session; the rest of this ADR is untouched. -->

**Context.** The owner asked for Mexican Lotería for the family's heritage celebration: "like a
bingo but with other characters". The loop is classic bingo's: the host calls, players mark their
board, the host checks a spoken claim. Only the board (4 x 4 pictures, not 5 x 5 numbers) and the
win patterns differ.

**Decision.**

1. **A fourth kind, `loteria`.** `games.kind` gains `loteria` (CHECK widened in `0015_loteria`;
   `String(20)` already fits). Config (validated by the service, not trusted raw):
   `pattern` (`line` | `corners` | `center` | `full`, default `line`) and `end_on_first_win`
   (default true). Status runs `draft -> open -> live -> ended` exactly like classic bingo.
2. **The deck.** 54 cards, ids 1-54, in one pure data module `domain/games/loteria_deck.py`
   (`DECK: tuple[Card, ...]`, `Card(id, name_es, name_en, emoji)`), in the traditional order.
   Pictures are **large emoji plus the Spanish name in big type** (no copyrighted artwork; the
   emoji is decoration, the name carries the meaning, `aria-label` is the name, and a mark is a
   check glyph plus colour, never colour alone). The deck is the same for every client: the API
   sends card **ids** and the frontend maps id to name/emoji from a mirror table
   (`frontend/src/lib/loteria-deck.ts`), pinned equal to the backend list by a backend unit test that
   reads the TypeScript file; the snapshot's calls also carry `name_es`/`name_en`/`emoji`, so the
   current card is right even if the mirror drifted.
3. **The tabla.** 16 distinct card ids drawn by `random.Random(seed ^ person.int)`, row-major 4 x 4,
   stored as decimal text. Mask bit `i` is square `i`; no free square. **Reroll** while the game is
   `open`: unlimited, replaces the squares, resets marks, refused 409 once `live` (same rule as the
   bingo reroll on `claude/games-card-reroll`, implemented separately here; a reroll takes
   its own `tie_seed`: random in production, the test header under test; it never returns the same
   tabla).
4. **Storage: reuse, do not add tables.** Cards live in `bingo_cards` and calls in `bingo_calls`.
   `bingo_calls.value BETWEEN 1 AND 75` already admits 1-54 and its unique indexes give "no repeat,
   no shared slot" for free. `bingo_cards` carries a `cardinality(squares) = 25` CHECK; migration
   `0015_loteria` replaces it with `cardinality(squares) IN (16, 25)` (and `marked_mask`'s range
   already covers 16 bits). Why this and not `loteria_cards`/`loteria_calls`: it is one CHECK swap
   instead of two tables, and every person-lifecycle path (export catalog, person delete, Start
   fresh, merge, seed, `SCOPED_TABLES`, the RLS pin count) already covers these tables, so none of
   those eight touch points can be missed or conflict with the in-flight bingo work. Cost: a table
   named "bingo" holds Lotería rows (the `games.kind` tells them apart; every query is by `game_id`);
   downgrade deletes Lotería games' rows before restoring the old CHECK. Rejected: a generic
   rename (churns a table two sessions are editing).
5. **Calling is seeded.** `reveal_seed` is set when the game is opened (`secrets.randbits(64)` or
   `X-FNH-Test-Seed` in `ENVIRONMENT=test`); the n-th card is `call_order(seed)[n]`, a shuffle of
   1-54. `POST /games/{id}/loteria/draw {expected_seq}` has classic bingo's semantics (409 on a
   stale count, 409 at 54 "Every card has been called.", game row `FOR UPDATE`). The seed never
   appears in a snapshot.
6. **Marking.** `PUT/DELETE /games/{id}/loteria/mark/{index}?person_id=` on your own tabla; a mark
   on an uncalled picture is 409 "That card hasn't been called."; unmarking is always allowed;
   marking never wins.
7. **Claims are verbal; the host checks.** Players shout "¡Lotería!". `POST
/games/{id}/loteria/check {person_id}` verifies against the **called set** and the pattern,
   never the player's taps, and returns `{valid, pattern: [indices] | null, missing}`. Invalid: no
   state change, no event, audited. Valid: `won_at = clock_timestamp()` if unset, and with
   `end_on_first_win` the game ends in the same transaction.
8. **Patterns** (pure, masks over the 16 squares): `line` any of 4 rows, 4 columns, 2 diagonals;
   `corners` squares 0, 3, 12, 15; `center` squares 5, 6, 9, 10; `full` all 16. `missing` is the
   fewest uncalled squares in any one pattern of the mode.
9. **Routes and files.** Own files, so the bingo work does not conflict: `domain/games/loteria.py`,
   `loteria_deck.py`, `services/loteria_service.py`, `api/v1/games_loteria.py`. Shared registries
   change add-only: `GameKind`, `AVAILABLE_KINDS`, `create_game` (a `loteria` branch),
   `GameCreateIn.pattern`, `GameOut.loteria`. Open/start reuse the new `/loteria/open` and
   `/loteria/start` (the bingo ones are bingo-only). End is the generic `/end`.
10. **Events/audit.** `game.loteria_called`, `game.loteria_checked`, plus the existing opened/
    started/ended; `GAME_CHANGED` on draw, open, start, join, reroll, valid check; `GAME_ACTIVITY`
    on a mark; nothing on an invalid check.
11. **Frontend.** Phone `loteria-screen.tsx` (tabla of big tiles: emoji, Spanish name, `aria-pressed`,
    inactive-until-called with an explanation, reroll button while open, current card and the last
    few calls above), host `loteria-host.tsx` (create form fields, open/start, **Draw**, current
    card huge, called list, per-player **Check**), TV `tv-loteria.tsx` (current card very large,
    recent cards, a 54-card called board, winner), all on the shared frames, ADR-0008 tokens, an
    `aria-live` region for each call and the winner. `PLAYABLE` and `KIND_COPY` gain `loteria`.
12. **Not in v1.** The spoken _canto_ (rhyme) and audio, undo of a draw, a phone "¡Lotería!"
    button, custom patterns, 4 x 4 vs 5 x 5 choice, artwork beyond emoji.

**Test plan** (targeted only). Pure modules at 100% with Hypothesis (tabla is 16 distinct deck ids;
`call_order` is a seeded permutation of 1-54; pattern functions agree with a brute-force oracle;
deck has 54 unique names). Real-Postgres integration: draws never repeat and follow a pinned seed;
stale `expected_seq` is 409; mark only called; false then true check; line, corners, center and
full; reroll open yes / live 409 / new squares; a Thanksgiving bingo game rejects Lotería routes
and vice versa; cross-household 404. Vitest for the deck mirror and helpers; one Playwright spec.

**OPEN (owner), with the default used.**

- **L1.** Default pattern: **Full tabla (owner, 2026-11-26)**. Line, four corners and centre four
  are host choices at creation.
- **L2.** A valid check ends the round: **yes, the first win ends it (owner, 2026-11-26)**;
  tickable off at creation.
- **L3.** Pictures: **emoji + Spanish name** (used). Original illustrated cards would be a later
  art task; the _canto_ (traditional rhyme, audio) is deferred.
- **L4.** Deck spelling and English glosses follow the list the owner supplied (e.g. "El Violoncello",
  "Las Jaras", "El Negrito", "El Apache"): **keep the traditional deck as supplied (owner,
  2026-11-26)**. They live in one data file.
- **L5.** Reroll is unlimited before the host starts (used); the same call as bingo's reroll.
- **L6.** Storage reuses the `bingo_cards`/`bingo_calls` tables (used; reasoning in point 4).
  Say if you would rather have dedicated tables.

### Amendment 2026-11-26: card reroll

Owner request: players may reroll their own bingo card. `POST /games/{id}/bingo/reroll` (body
`{person_id}`, both modes) replaces the caller's own card in place while the game is `open`, as
often as they like. The `bingo_cards` row is updated (`squares`, `marked_mask` back to the free
centre's mask, `won_at` stays null), so there is no migration and no counter. It is 409 once the
game is `draft`, `live` or `ended`, 403 for a person this phone does not act as, 404 across
households, and behind the same consent gate as join. The seed follows join's pattern
(`tie_seed`, pinned by `X-FNH-Test-Seed` in test) with the old squares mixed in, and a guard loop
means the new card always differs from the old one. It publishes `game.activity` because the host's
"N to go" changes. Nobody else's card is touched. The phone shows a **New card** button only while
the game is open and the person has a card.

### Amendment 2026-11-26: more bingo win patterns

`config.win_mode` (classic and Thanksgiving share it) grows from `line | blackout` to
`line | blackout | corners | x | stamp`, chosen by the host at creation (default still `line`;
existing games are unchanged). `corners` is the four corner squares; `x` is both diagonals (9
squares); `stamp` is any one 2x2 block in a corner of the card (four candidate masks). The masks
live in `domain/games/bingo.py` (`patterns(mode)`), and `has_win`, `squares_from_bingo` and
classic's `bingo_classic.pattern` all read that one list, so the host Check and Thanksgiving's
automatic win agree. A pattern that includes the centre (`x`) counts the free square as marked.
The phone's own "to go" count (`markedToGo`, `winPatterns` in `lib/bingo.ts`) mirrors the server.
Validation is `WIN_MODES` in the service (422 from the schema otherwise). No migration.

Also decided the same day: Lotería's default pattern is the full tabla (L1), and on the classic
phone screen the "Last call" block is compact and the separate progress line is gone (kept as
visually hidden live text for screen readers; the player strip and the host's Check carry it).
