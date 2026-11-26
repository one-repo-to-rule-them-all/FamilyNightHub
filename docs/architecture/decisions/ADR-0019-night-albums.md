# ADR-0019: Night albums, so photos no longer need a movie night

## Status

Proposed (2026-11-26). Design only; nothing is built. The owner answered all five open questions
on 2026-11-26, each with the recommended default (recorded at the end).

## Context

Photos belong to a movie night. `photos.session_id` is required with a composite FK to `sessions`
([ADR-0005](ADR-0005-photo-pipeline-and-storage.md)), uploads go through
`POST /sessions/{id}/photos`, which refuses unless the night's effective status is `tonight` or
`closed` (`session_state.check_photos_open`), object keys are
`households/{hid}/sessions/{sid}/{photo_id}.jpg`, the album page is `/albums/[session]`, the TV
slideshow lives on `/tv/[session]`, and the export writes `photos/<night id>/<photo id>.jpg`.

That fitted a movie app. The Games tab ([ADR-0018](ADR-0018-games-tab.md)) made evenings without a
movie normal: on Thanksgiving the family plays bingo, Lotería and Scattergories and fills a
gratitude jar, and there is nowhere to drop a photo unless someone creates a movie night first. The
owner hit exactly this while testing on staging and asked for photos to stand on their own.

Two things already work without a night and should keep working: the Night reel
(`GET /reel`, ADR-0018 amendment) selects ready photos by `created_at`, not by night, and moderation
(hide, admin hard delete with a tombstone, the nightly backup copy, orphan sweep) works per photo
row.

## Decision

### 1. An album per household per "night date"

- New household-scoped table **`albums`**: `id`, `household_id`, `night_date` (a calendar date),
  `title` (nullable; the UI falls back to a date label such as "Thu 26 Nov"), `created_at`.
  `unique (household_id, night_date)`. FORCE RLS and `household_isolation` in the same migration;
  composite `(id, household_id)` key for children (ADR-0003).
- A **night date** is the household's local date with a **4:00 cutoff**: a photo taken at 1:30 on
  Friday morning still belongs to Thursday's family night. One pure function,
  `domain/albums.night_date(now, tz, cutoff=4h)`, unit-tested around midnight and DST.
- The album is created **lazily** on the first upload of a night date
  (`INSERT … ON CONFLICT (household_id, night_date) DO NOTHING`), so nobody has to "start" anything.
  A movie night and the games of the same evening share **one** album.

### 2. Photos point at an album; the movie night becomes optional

- `photos.album_id` (composite FK to `albums`) becomes the photo's home; `photos.session_id`
  becomes **nullable** and is kept, so a photo uploaded from a movie night still knows its night
  (history pages and the night's own slideshow keep working).
- New uploads: `POST /api/v1/albums/tonight/photos {person_id, taken_on?}` resolves (or creates)
  tonight's album and returns the same presigned PUTs. Same rules as today: a person bound to the
  phone (`require_can_act_as`), the **consent gate** (ADR-0017), 500 photos per album, JPEG only,
  HEAD check on complete, GPS stripped on the phone. The existing
  `POST /sessions/{id}/photos` keeps working and simply files the photo into that night's album
  (the night's date), so nothing on the phone breaks during the switch.
- No status gate for albums: tonight's album is open all evening. A past album is read-only for
  new uploads after its night date ends (owner answer 3).
- New object keys: `households/{hid}/albums/{album_id}/{photo_id}.jpg` (and `_thumb`). Existing
  keys are **not** moved: every reader already uses the key stored on the row, so the backup worker,
  orphan sweep, delete propagation and presigning need no change.

### 3. Reading

- `GET /api/v1/albums?limit=` (any device or account): recent albums with a cover thumbnail and
  count. `GET /api/v1/albums/{id}/photos`: the same response as today's album endpoint
  (fresh presigned GETs per request, hidden photos only for `sessions:run` accounts, reactions).
- Phone: a **Photos** entry in the Games tab and on Home ("Tonight's album"), using the existing
  `PhotoAlbum` component and upload queue unchanged except for the endpoint. `/albums/[session]`
  keeps working and redirects to its album.
- TV: `/tv/albums/[id]` reuses the existing slideshow (`use-slideshow.ts`). The household TV target
  (ADR-0018) gains an "album" target only if it stays a small change; otherwise the Night reel,
  which already shows photos, is the TV's way to show them (owner answer 4).
- Night reel: unchanged; it already reads photos by time. It may switch to "tonight's album" as
  its source later for an exact match.

### 4. Lifecycle, privacy and export

- **Person delete and merge**: photos already go with the person; nothing new. An album with no
  photos left stays as an empty shell (harmless) or is removed by the same transaction (cheap;
  chosen).
- **Start fresh** deletes albums with the photos.
- **Export**: `photos/<night date>/<photo id>.jpg` plus an `albums.json`; existing exports change
  their folder name only.
- **Hide / delete / backup**: unchanged (per photo row).
- **Consent**: unchanged and still mandatory on every upload path; children's photos are why it
  exists.

### 5. Migration (expand, then contract)

1. **`0016_night_albums`** (expand): create `albums` (RLS), add nullable `photos.album_id` with its
   composite FK and index, make `photos.session_id` nullable, and **backfill**: one album per
   (household, night date of the session's `revealed_at` or `created_at`), `photos.album_id` set
   from its session. Two movie nights on the same date share an album (owner answer 2).
2. Ship the code that writes and reads `album_id`.
3. **`0017_albums_required`** (contract, a later deploy): `photos.album_id NOT NULL`.

Both steps are safe to deploy with the previous code still running, per `05-data.md`.

## Alternatives considered

**An explicit "family night" event** that hosts start and that owns movie nights, games and the
album. The most expressive model, and the right one if evenings ever need their own page, code or
schedule. Rejected for now: it adds a step for the host on the night itself and changes how movie
nights and games are created. The date album gets the same result without a new ritual, and could
be promoted to an event later (an album would simply gain an `event_id`).

**Photos attached to a game** (`photos.game_id`). Rejected: an evening has several games and the
photos are of the evening, not of a bingo round; it would scatter one night across many albums.

**Make `session_id` nullable and nothing else.** Rejected: orphan photos with no album have no page,
no TV slideshow and no export folder.

## Consequences

- One new household table (RLS pin and isolation suite updated), one nullable column, one new
  required column after the contract step. No object moves, so storage, backups and the worker are
  untouched.
- The phone gains an always-available "add photos" entry, which is the point; the 500-per-album cap
  and the moderation tools keep a runaway evening in check.
- Timezone handling becomes real: today nothing in the app needs the household's local date.

**Tests**: unit tests for `night_date` (cutoff, midnight, DST); integration tests against real
Postgres for lazy album creation (two phones at once create one album), upload without any movie
night, consent gate, a night's upload landing in the date album, hidden photos, cross-household 404,
backfill correctness, person delete; Playwright: upload a photo on a games-only evening and see it
in the album and on the reel.

## Owner answers (2026-11-26)

1. **Timezone:** a household `settings.timezone`, preset to `America/Chicago`, editable in Settings.
2. **Two movie nights on one date:** one album per date; they share it.
3. **Past albums:** uploads allowed for the night date plus 3 days, then read-only (admins can
   still hide or delete).
4. **TV:** photos reach the TV through the Night reel; a dedicated album slideshow only if it stays
   small.
5. **Titles:** a date label ("Thu 26 Nov") that the host can rename (for example "Thanksgiving 2026").
