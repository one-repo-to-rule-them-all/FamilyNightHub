# Crowd layout findings (8 and 12 players)

Owner request: see how the Games screens look when 8+ people are playing (who has voted, who has
finished). Everything here ran on a LOCAL stack (own Postgres/Redis, API :8290, Next :3290); the
deployed staging and its data were never touched. Images: `docs/screenshots/crowd/`, named
`<game>-<state>-<players>-<view>.jpg` (`tv-1920x1080`, `tv-1280x720`, `tv-3840x2160` (4K, saved
at 1920 wide), `host`, `phone`). The shots in that folder are the **after** state; the "before"
problems are described here (they were seen on the same simulated games).

## How to reproduce

```powershell
# local stack on your own ports, migrated, API + web running (see frontend/playwright.config.ts)
cd backend
uv run python scripts/simulate_crowd.py --players 12 --game scattergories --state revealed > sim.json
cd ../frontend
node e2e/support/crowd-shots.mjs ../backend/sim.json ../docs/screenshots/crowd my-run --tv 1920x1080,1280x720 --host --phone --phone-as "Grandma Esperanza" --base http://localhost:3290
```

Games: `bingo-classic | bingo-thanksgiving | jar | scattergories`; states: `lobby | mid | revealed |
finished`. The simulator makes up to 16 people (long names such as "Grandma Esperanza" and "Great-Grandpa
Wilhelmina-Ann", kids, accents, emoji, colours), each its own device through `/join` and the PIN
bind (test PIN only), and drives the game through the real API (bingo draws/marks/checks, jar
notes incl. anonymous, scatter answers incl. a duplicate and players who answered nothing).

## What was wrong (fixed)

| # | Problem | Seen in | Fix |
|---|---------|---------|-----|
| 1 | **TV stage lost rows off the bottom.** The stage only scrolled, and a TV cannot scroll: classic bingo with 12 players hid the G and O rows of the called board and half of the third strip row. | `bingo-classic-mid-12-tv-*` | `FitStage` (new, `components/games/fit-stage.tsx`) shrinks the stage to the height the frame leaves (floor 0.4). |
| 2 | **Scattergories letter tile was 35 em wide** (`w-[7em]` on a `text-[5em]` element), so with 12 players the letter box dominated the screen and the category list was clipped. | `scattergories-mid-12-tv-*` | tile now `w-[1.4em]` (7 em of the root). |
| 3 | **Player strip too tall at 12 players** (2-row cap, 3rd row half visible, long names owning a row). | all TV views | tighter type for compact/dense, name column capped per density (`stripNameMaxEm`), TV cap 3 rows (compact) / 4 (dense), host 4 / 5. |
| 4 | **Win banner pushed the strip off the screen** when several people win at once (Thanksgiving bingo, 5 winners at 1280x720). | `bingo-thanksgiving-finished-12-tv-1280x720` | `FitBanner` caps the banner to 40% of the frame and shrinks its text. |
| 5 | **Scattergories reveal was unreadable on a TV** with a crowd (6 categories x up to 12 answers in one column, leaderboard of 12 rows). | `scattergories-revealed-12-tv-*` | TV shows one category at a time (3 answer columns, turns every 9 s, "Category 1 of 6") once a round has more than 18 answers; leaderboard lists the top 8 in two columns plus "and N more". Rounds with 18 or fewer answers look as before. |
| 6 | **Host strip pinned to the bottom ate a quarter of a laptop screen** at 8+ players and overlapped the Check bingo list. | `bingo-classic-mid-12-host` | the host strip only sticks while it is short (`stripSticky`, 6 players or fewer); a crowd's scrolls with the page. |

Pure helpers (vitest, `src/lib/game-layout.test.ts`): `stripNameMaxEm`, `stripSticky`, `fitScale`,
`needsResultsPaging`, `nextPage`, plus the changed `stripMaxRows`.

## What looks good

- Player strip chips wrap cleanly for 8 and 12 players on the TV at 1920x1080, 1280x720 and 4K, and
  on the host; long names truncate with an ellipsis, short ones stay whole.
- Status chips read well: "1 away", "2 to go", "Bingo!" with a check and the cinema border,
  "3 of 6 answered" (`scattergories-mid-12-host`, `bingo-classic-mid-12-host`), "shared a note"
  (`jar-revealed-12-tv-1920x1080`). Winners never rely on colour alone.
- Classic bingo TV hides "N away" (suspense) but shows "Bingo!" for confirmed winners.
- The host's Check bingo list stays one tidy card per player at 12 and sorts closest-first.
- Jar and the 12-player jar strip: the strip only lists people behind revealed notes, so it grows
  as the reveal proceeds, as designed.
- Phone views (`*-phone.jpg`, Pixel 7): the strip is one sideways-scrolling row under the card
  and the stage is not squeezed by the crowd.

## Still open (not fixed, your call)

- **Phone strip scrolls sideways**, so on a phone you only see the first two or three people; there
  is no "+N more" hint. Fine for the stage, but if "who has finished" matters on phones consider a
  count ("7 of 12 answered") in the header (needs a game-screen change, left alone: other sessions
  own those files).
- **The jar TV strip says nothing about who has dropped a note** while notes are still being
  collected (by design: authors may be anonymous). If the owner wants a "9 of 12 have added a note"
  line, it needs a count on the snapshot (server) rather than a layout change.
- Scatter results show a duplicate answer struck through with "Someone else had it" in tiny type
  on the TV; readable at 1080p, small at 720p.
- 16+ players: strip is "dense" (0.9 em) and fits on the TV, but nothing was checked above 12
  with screenshots.

## Not run

Full pytest, full Playwright, the iphone project, and the `games-tv` / `host-tv` specs were not run
(targeted tests only). Ran: vitest for `src/components/games`, `src/lib`, `src/app/tv`,
`src/app/host/games` (43 files, 445 tests) and `npx playwright test e2e/games-jar.spec.ts
e2e/games-bingo.spec.ts e2e/games-bingo-classic.spec.ts e2e/games-scattergories.spec.ts
--project=pixel` (4 passed).
