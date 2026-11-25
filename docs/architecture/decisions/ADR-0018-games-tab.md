# ADR-0018: A Games tab: household-scoped party games run by a host, played from phones, shown on the TV

## Status

Accepted (2026-11-24), with the review answers recorded at the end. Slices A (jar), B (bingo, migration `0010_bingo`) and C (scattergories, migration `0011_scattergories`) built.
Numbered 0018 because 0011 is claimed by the open room-types draft (PR #24) and 0012 is unused;
that ADR is about *choosing* a game for a night, this one is about *playing* one, and they do not
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

| Slice | Tables | Notes |
|---|---|---|
| A | `games`, `game_players`, `gratitude_notes` | `gratitude_notes`: `game_id`, `person_id` (the author), `body` (1-280 chars), `anonymous`, `reveal_position`, `revealed_at`, `hidden_at` |
| B | `bingo_cards` | `game_id`, `person_id`, `squares` (25 strings, snapshotted from the pool so a later pool edit cannot change a card in play), `marked_mask` (25-bit int), `won_at`; unique (game, person) |
| C | `scatter_rounds`, `scatter_answers` | round: `game_id`, `round_no`, `letter`, `categories jsonb`, `duration_seconds`, `started_at`, `ends_at`, `revealed_at`; answer: `round_id`, `person_id`, `category_index`, `text`, `host_verdict` (null / accepted / rejected); unique (round, person, category) |

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
an answer arriving after `ends_at` plus a 2-second grace is 409, and the round's *effective*
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
function and never stored, so a host override cannot leave a stale score: an answer is *valid*
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
game-night *votes*). Rejected here: a played game has no shortlist, ballots or tally, and
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
