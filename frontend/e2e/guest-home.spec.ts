import { type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
  apiFromPhone,
  hostClosesNight,
  hostClosesVoting,
  joinAs,
  newPhone,
  pickPerson,
  pinFor,
  switchTo,
  typePin,
  vote,
} from "./support/phones";
import { JPEG_FIXTURE, PRESIGNED, UPLOAD_TIMEOUT } from "./support/photos";
import { castPhoneBallot } from "./support/host";
import { expect, type SeededNight, seedNight, test } from "./support/seed";

/**
 * Guest experience v2 (#58): the phone's Home, History, Me, the bottom nav and the new-night toast
 * with its 60 s auto-move (#70), as proposals/guest-home.md §12 (AC-H0–H5) at 360×640.
 *
 * Every countdown AC runs on Playwright's clock: `page.clock.install()` before the first load,
 * frozen with `freezeClock` just before the new night is started, then moved by hand. While the
 * clock is frozen nothing timer-driven happens on its own (TanStack Query's polls and even its
 * render notifications sit on `setTimeout`), so `stepUntil` moves it in quarter-second steps until
 * the screen catches up, and no test waits 60 real seconds. A quarter second can't reach the
 * countdown's 1 s tick, so it still reads 60 when the toast first shows.
 *
 * Each test seeds its own household (Ava, Leo, Mia). The host's moves (start a night, add titles,
 * open/close voting, end it) go straight to the API with the seeded admin session, as in
 * support/phones.ts.
 */

const API_URL = `http://localhost:${process.env.E2E_API_PORT ?? 8201}`;
const CSRF = "e2e-host-csrf";
const HANDOFF_WAIT = 7_000;
const FORBIDDEN_WORDS = /\b(session|device|binding|profile)s?\b/i;

test.use({ viewport: { width: 360, height: 640 } });

test.beforeEach(async ({ page }) => {
  // Same 360×640 phone either way, so once per run is enough (the iPhone project would only
  // repeat it). `page` is listed so Playwright sees a destructured fixture.
  void page;
  test.skip(test.info().project.name !== "pixel", "guest-home runs on the pixel project only");
});

// --- The host, straight against the API ----------------------------------------------------

const asHost = (night: SeededNight) => ({
  Cookie: `fnh_session=${night.hostCookie}; fnh_csrf=${CSRF}`,
  "X-FNH-CSRF": CSRF,
});

/** `night` pointed at another of the household's nights, for the shared helpers. */
const other = (night: SeededNight, sessionId: string): SeededNight => ({ ...night, sessionId });

/** The host starts a new night (draft), optionally with typed titles and voting open. */
async function hostStartsNight(
  request: APIRequestContext,
  night: SeededNight,
  { movies = [], openVoting = false }: { movies?: string[]; openVoting?: boolean } = {},
): Promise<string> {
  const created = await request.post(`${API_URL}/api/v1/sessions`, {
    headers: asHost(night),
    data: {},
  });
  expect(created.status()).toBe(201);
  const { session_id: id } = (await created.json()) as { session_id: string };
  for (const title of movies) {
    const added = await request.post(`${API_URL}/api/v1/sessions/${id}/options`, {
      headers: asHost(night),
      data: { title },
    });
    expect(added.status()).toBe(201);
  }
  if (openVoting) await hostOpensVoting(request, night, id);
  return id;
}

async function hostOpensVoting(request: APIRequestContext, night: SeededNight, id: string) {
  const opened = await request.post(`${API_URL}/api/v1/sessions/${id}/open-voting`, {
    headers: asHost(night),
  });
  expect(opened.status()).toBe(200);
}

/**
 * The host ends a night that was revealed moments ago. `revealed → tonight` is lazy and takes
 * REVEAL_SETTLE (30 s) of server time, and only a write persists it, so retry the close until the
 * server accepts it.
 */
async function hostClosesWhenSettled(request: APIRequestContext, night: SeededNight, id: string) {
  await expect
    .poll(
      async () =>
        (
          await request.post(`${API_URL}/api/v1/sessions/${id}/close`, {
            headers: asHost(night),
          })
        ).status(),
      { timeout: 45_000, intervals: [2_000] },
    )
    .toBe(200);
}

// --- Screens and the clock ------------------------------------------------------------------

const screen = (page: Page, id: string) => page.locator(`[data-screen="${id}"]`);
const primary = (page: Page) => page.getByTestId("primary-action");
const tonightCard = (page: Page) => page.getByTestId("tonight-card");
// The new-night toast (issue #70): mounted once in the shell, above the nav. `data-phase` is
// `setup` while the night is a draft (no Join, no countdown) and `started` once voting is open.
const toast = (page: Page) => page.getByTestId("night-toast");
const toastJoin = (page: Page) => page.getByTestId("toast-join");
const handoffStay = (page: Page) => page.getByTestId("handoff-stay");
const countdown = (page: Page) => page.getByTestId("handoff-countdown");
/** That's a wrap's and the recap's small "Go to tonight's movie night" link. */
const liveLink = (page: Page) => page.locator("[data-live-link]");

/** The toast sits above the bottom nav, never over it (AC-H3.4). */
async function expectToastAboveNav(page: Page) {
  const box = await toast(page).boundingBox();
  const nav = await page.getByTestId("bottom-nav").boundingBox();
  expect(box && nav, "toast and nav are on screen").toBeTruthy();
  expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y);
}

/** The phone's own id for `name` (GET /people as this phone). */
async function personId(page: Page, name: string): Promise<string> {
  const people = (await apiFromPhone(page, "GET", "/people")).body as {
    id: string;
    name: string;
  }[];
  const person = people.find((p) => p.name === name);
  expect(person, `${name} is on this phone's list`).toBeTruthy();
  return person!.id;
}

/** Who this phone is acting as, per the server (ADR-0014: one current person). */
async function currentName(page: Page): Promise<string | undefined> {
  const people = (await apiFromPhone(page, "GET", "/people")).body as {
    name: string;
    current: boolean;
    binding: string;
  }[];
  return people.find((p) => p.current && p.binding === "mine")?.name;
}

/** Stops the page's (installed) clock a moment from now: from here time moves only by hand. */
async function freezeClock(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
}

/**
 * Moves the frozen clock in small steps until `done()` holds, polling in real time in between so
 * network answers already on the wire can land. Each step is under the countdown's 1 s tick (see
 * the header).
 */
async function stepUntil(
  page: Page,
  done: () => Promise<boolean>,
  { step = 250, timeout = 20_000 }: { step?: number; timeout?: number } = {},
) {
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        await page.clock.runFor(step);
        return false;
      },
      { timeout, intervals: [40] },
    )
    .toBe(true);
}

const isVisible = (locator: Locator) => () => locator.isVisible();

/**
 * Lets `ms` of app time pass on the installed (running) clock, then waits for the next live-night
 * poll to land, so any move the app was going to make on that data has started by the time the
 * caller asserts the phone is still where it was. `ms` ≥ 5 s covers one poll (LIVE_NIGHT_POLL_MS).
 */
async function letTimePass(page: Page, ms: number) {
  const polled = page.waitForResponse((r) => r.url().includes("/api/v1/sessions?"));
  await page.clock.runFor(ms);
  await polled;
  await page.clock.runFor(250); // flush TanStack Query's notify (setTimeout 0)
}

async function secondsLeft(page: Page): Promise<number> {
  return Number(await countdown(page).getAttribute("data-seconds"));
}

/** A bottom-nav tab. By `data-nav`: on Home the live dot's label comes first in the link's name. */
const navLink = (page: Page, tab: string) =>
  page.getByTestId("bottom-nav").locator(`[data-nav="${tab}"]`);

/**
 * Browser Back with the clock running (Next's history navigation doesn't finish on a frozen
 * clock), frozen again once the page is back at `path`.
 */
async function backTo(page: Page, path: string) {
  await page.clock.resume();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.locator("main[data-screen]")).toBeVisible();
  await freezeClock(page);
}

/** AC-H0.1: three links, ≥ 56 px tall, the active one marked. */
async function expectBottomNav(page: Page, active: "Home" | "History" | "Me") {
  const nav = page.getByTestId("bottom-nav");
  await expect(nav).toBeVisible();
  const links = nav.getByRole("link");
  await expect(links).toHaveCount(3);
  for (const name of ["Home", "History", "Me"]) {
    const link = navLink(page, name.toLowerCase());
    const box = await link.boundingBox();
    expect(box?.height ?? 0, `${name} tab height`).toBeGreaterThanOrEqual(56);
    if (name === active) await expect(link).toHaveAttribute("aria-current", "page");
    else await expect(link).not.toHaveAttribute("aria-current", "page");
  }
}

/** AC-H0.4: none of the words the spec keeps out of a guest's sight. */
async function expectNoForbiddenWords(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(FORBIDDEN_WORDS);
}

// ---------------------------------------------------------------------------------------------

test.describe("guest home (#58)", () => {
  // Whole journeys with several PIN claims (argon2) and clock-driven waits; past nights also waits
  // out one real 30 s reveal settle.
  test.describe.configure({ timeout: 120_000 });

  test("Home follows a night from nothing on to rated (T7 → T0 → T1 → T2 → T4/T3 → T5)", async ({
    page,
    browser,
    request,
  }) => {
    const night = seedNight({ movies: 3, tonight: true, attended: true });
    await page.clock.install();
    await joinAs(page, night, ["Ava"]);
    const mia = await newPhone(browser);
    await joinAs(mia, night, ["Mia"]);

    // AC-H1.5 (T7): the night ends with Ava unrated → "Rate it" → That's a wrap, stars open.
    await hostClosesNight(request, night);
    await page.goto("/");
    await expect(screen(page, "home")).toBeVisible();
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T7");
    await expect(primary(page)).toHaveCount(1); // AC-H1.6
    await expect(primary(page)).toHaveText("Rate it");
    await expectBottomNav(page, "Home");
    await expectNoForbiddenWords(page);
    await primary(page).click();
    await expect(screen(page, "wrap")).toBeVisible();
    const stars = page.getByTestId("rating-panel");
    await expect(stars).toBeVisible();
    await stars.getByRole("radio", { name: "5 stars" }).click();
    await expect(stars.getByRole("radio", { name: "5 stars" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // AC-H1.1 (T0): nothing live, nothing to rate.
    await navLink(page, "home").click();
    await expect(screen(page, "home")).toBeVisible();
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T0");
    await expect(primary(page)).toHaveCount(0);
    const waiting = page.getByTestId("waiting");
    await expect(waiting).toHaveCount(1);
    await expect(waiting.locator("[aria-live]")).not.toHaveCount(0);

    // AC-H1.7: at most 3 recent nights, and "See all my nights" opens History → Mine. (Reload:
    // Home's profile query is still the one from before the rating.)
    await page.reload();
    const recent = page.getByTestId("recent-night");
    expect(await recent.count()).toBeLessThanOrEqual(3);
    await expect(recent).toHaveCount(1);
    await page.getByTestId("recent-all").click();
    await expect(page).toHaveURL(/\/history\?tab=mine$/);
    await navLink(page, "home").click();
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T0");

    // AC-H1.2 (the staging bug): a night started elsewhere shows up in place, within 7 s.
    const titles = ["Paddington 2", "Spirited Away", "The Iron Giant"];
    const second = await hostStartsNight(request, night, { movies: titles });
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T1", { timeout: 7_000 });
    await expect(page.getByTestId("just-started")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await hostOpensVoting(request, night, second);
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T2", { timeout: 7_000 });
    await expect(primary(page)).toHaveCount(1);
    await expect(primary(page)).toHaveText("Vote now");

    // AC-H2.3 / AC-H0.2: the ballot has no nav and a "Home" link; Home then stays put.
    await primary(page).click();
    await expect(screen(page, "ballot")).toBeVisible();
    await expect(page.getByTestId("bottom-nav")).toHaveCount(0);
    await page.getByRole("link", { name: "Home" }).click();
    await expect(screen(page, "home")).toBeVisible();
    await letTimePass(page, 10_000);
    await expect(screen(page, "home")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    // AC-H1.3 (T4): Ava votes on a one-person phone; another phone's vote moves the count.
    await primary(page).click();
    await vote(page, "Ava", titles.slice(0, 2));
    await navLink(page, "home").click();
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T4");
    await expect(primary(page)).toHaveCount(0); // AC-H1.6: T4 is a waiting state
    await expect(page.getByTestId("waiting")).toHaveCount(1);
    await expect(tonightCard(page)).toContainText(/1 of \d+ voted/);
    expect(await castPhoneBallot(mia, second, "Mia", titles.slice(1, 3))).toBe(204);
    await expect(tonightCard(page)).toContainText(/2 of \d+ voted/, { timeout: 7_000 });

    // AC-H1.3 (T3): the phone also holds Leo, who hasn't voted → "Pass to next person".
    await page.goto("/who");
    await pickPerson(page, "Leo");
    await expect(screen(page, "ballot")).toBeVisible();
    await switchTo(page, "Ava");
    await navLink(page, "home").click();
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T3");
    await expect(primary(page)).toHaveCount(1);
    await expect(primary(page)).toHaveText("Pass to next person");
    await switchTo(page, "Leo", { via: "pass" });
    await expect(screen(page, "ballot")).toBeVisible();

    // AC-H1.4 (T5): voting closes → "See the winner".
    await hostClosesVoting(request, other(night, second));
    await page.getByRole("link", { name: "Home" }).click();
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T5", { timeout: 7_000 });
    await expect(primary(page)).toHaveCount(1);
    await expect(primary(page)).toHaveText("See the winner");
    await mia.context().close();
  });

  test("a cold open goes to the ballot only while the person still has to vote", async ({
    page,
    request,
  }) => {
    const night = seedNight({ movies: 3, tonight: true });
    await page.clock.install();
    await joinAs(page, night, ["Ava"]);

    // AC-H2.6 + AC-H1.4 (T6): a `tonight` night opens on Home with "Add photos".
    await page.goto("/");
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T6");
    await expect(primary(page)).toHaveCount(1);
    await expect(primary(page)).toHaveText("Add photos");
    await expect(page.getByTestId("tonight-rate")).toHaveText("Already watched? Rate it");
    expect(new URL(page.url()).pathname).toBe("/");

    // AC-H2.6: a `draft` night → T1, no redirect.
    await hostClosesNight(request, night);
    const titles = ["Coco", "Wall-E", "Up"];
    const second = await hostStartsNight(request, night, { movies: titles });
    await page.goto("/");
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T1");
    await letTimePass(page, 5_000);
    expect(new URL(page.url()).pathname).toBe("/");

    // AC-H2.4: voting is open and Ava hasn't voted → straight to the ballot, no tap.
    await hostOpensVoting(request, night, second);
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/s/${second}$`), { timeout: 3_000 });
    await expect(screen(page, "ballot")).toBeVisible({ timeout: 3_000 });

    // AC-H2.5: once her ballot is in, a cold open stays on Home (T4) for 10 s.
    expect(await castPhoneBallot(page, second, "Ava", titles.slice(0, 2))).toBe(204);
    await page.goto("/");
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T4");
    await letTimePass(page, 10_000);
    await expect(screen(page, "home")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    // AC-H2.6: a `revealed` night → T5, no redirect.
    await hostClosesVoting(request, other(night, second));
    await page.goto("/");
    await expect(tonightCard(page)).toHaveAttribute("data-state", "T5");
    await letTimePass(page, 5_000);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("That's a wrap: the setup toast for a draft, then Join and the 60 s countdown once voting opens, pausing for uploads and dialogs", async ({
    page,
    request,
  }) => {
    const night = seedNight({ movies: 3, tonight: true });
    await page.clock.install();
    await joinAs(page, night, ["Ava"]);
    await hostClosesNight(request, night);

    // AC-H3.2: no live night, unrated → the star row is the primary.
    await page.goto(`/s/${night.sessionId}`);
    await expect(screen(page, "wrap")).toBeVisible();
    await expect(primary(page)).toHaveCount(1);
    await expect(primary(page).getByTestId("rating-panel")).toBeVisible();
    await expectBottomNav(page, "Home");
    await expect(toast(page)).toHaveCount(0);

    // AC-H3.12 (the #70 Join bug): a night still in draft only says it is being set up. No Join,
    // no countdown, and the phone stays put; OK hides it.
    await freezeClock(page);
    const live = await hostStartsNight(request, night, { movies: ["Coco", "Up", "Moana"] });
    await stepUntil(page, isVisible(toast(page)), { timeout: HANDOFF_WAIT + 5_000 });
    await expect(toast(page)).toHaveAttribute("data-phase", "setup");
    await expect(toast(page)).toContainText("Movie night is being set up");
    await expect(toastJoin(page)).toHaveCount(0);
    await expect(countdown(page)).toHaveCount(0);
    await page.clock.runFor(60_000);
    expect(new URL(page.url()).pathname).toBe(`/s/${night.sessionId}`);
    await page.getByTestId("toast-hide").click();
    await expect(toast(page)).toHaveCount(0);

    // AC-H3.1 / AC-H3.5: voting opens → the full toast, 60 s on the clock, above the nav. The
    // wrap's own primary is the small live-night link; the toast's buttons are not primaries.
    await hostOpensVoting(request, night, live);
    await stepUntil(page, isVisible(toast(page)), { timeout: HANDOFF_WAIT + 5_000 });
    await expect(toast(page)).toHaveAttribute("data-phase", "started");
    await expect(toast(page)).toHaveAttribute("data-night", live);
    await expect(toast(page)).toContainText("Movie night started");
    await expect(primary(page)).toHaveCount(1);
    await expect(primary(page)).toHaveText("Go to tonight's movie night");
    await expect(countdown(page)).toHaveAttribute("data-seconds", "60");
    await expect(countdown(page)).toHaveText("Taking you there in 60s");
    await expect(handoffStay(page)).toHaveText("Stay here");
    await expect(toastJoin(page)).toHaveText("Join");
    await expectToastAboveNav(page);

    // AC-H3.9: an upload in flight at 50 s holds the countdown.
    await page.clock.runFor(10_000);
    await expect(countdown(page)).toHaveAttribute("data-seconds", "50");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => PRESIGNED.test(url.href),
      async (route) => {
        if (route.request().method() === "PUT") await held;
        await route.continue();
      },
    );
    await page.getByTestId("photo-input").setInputFiles([JPEG_FIXTURE]);
    await stepUntil(page, async () => (await countdown(page).getAttribute("data-paused")) !== null);
    await expect(countdown(page)).toHaveText("Paused while you finish up");
    await page.clock.runFor(60_000);
    await expect(countdown(page)).toHaveAttribute("data-seconds", "50");
    await expect(countdown(page)).toHaveText("Paused while you finish up");
    release();
    const row = page.getByTestId("upload-list").getByRole("listitem").first();
    await stepUntil(page, async () => (await row.getAttribute("data-state")) === "done", {
      timeout: UPLOAD_TIMEOUT,
    });
    // It resumes from 50: the hold is read once a second, so the next tick un-pauses and counts
    // on (one of the quarter-second steps above may already have been that tick).
    await page.clock.runFor(1_000);
    await expect(countdown(page)).not.toHaveAttribute("data-paused");
    const resumed = await secondsLeft(page);
    expect([48, 49]).toContain(resumed);

    // AC-H3.10: the switch sheet (a <dialog>) at 30 s holds it; closing it resumes.
    await page.clock.runFor((resumed - 30) * 1_000);
    expect(await secondsLeft(page)).toBe(30);
    await page.getByTestId("app-bar-person").click();
    await expect(page.getByTestId("switch-sheet")).toBeVisible();
    await page.clock.runFor(90_000);
    expect(await secondsLeft(page)).toBe(30);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("switch-sheet")).toHaveCount(0);
    await page.clock.runFor(10_000);
    expect(await secondsLeft(page)).toBe(20);

    // …and so does the photo viewer (the photo uploaded above, in this night's album).
    await page.getByRole("button", { name: "Open photo by Ava" }).first().click();
    await expect(page.getByTestId("photo-viewer")).toBeVisible();
    await page.clock.runFor(90_000);
    expect(await secondsLeft(page)).toBe(20);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("photo-viewer")).toHaveCount(0);

    // AC-H3.6: no interaction → the phone moves to the new night's ballot; Back returns to the
    // wrap, where the night now counts as seen: no toast, just the live-night link.
    await page.clock.runFor(20_000);
    await stepUntil(page, isVisible(screen(page, "ballot")));
    expect(new URL(page.url()).pathname).toBe(`/s/${live}`);
    await backTo(page, `/s/${night.sessionId}`);
    await expect(screen(page, "wrap")).toBeVisible();
    await page.clock.runFor(5_000);
    await expect(toast(page)).toHaveCount(0);

    // AC-H3.1: the live-night link takes the phone to that night's screen.
    await primary(page).click();
    await stepUntil(page, isVisible(screen(page, "ballot")));
    expect(new URL(page.url()).pathname).toBe(`/s/${live}`);
  });

  test("past nights: recap, History, Stay here, and the toast following the phone across screens", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // Two closed nights where Ava voted in the older one: A (voted), then B (latest).
    const night = seedNight({ movies: 3, openVoting: true });
    await page.clock.install();
    await joinAs(page, night, ["Ava"]);
    await expect(screen(page, "ballot")).toBeVisible();
    await vote(page, "Ava", night.movies.slice(0, 2));
    const closedA = await hostClosesVoting(request, night);
    const winnerA = closedA.options.find((o) => o.id === closedA.result?.winner_option_id)?.title;
    const b = await hostStartsNight(request, night, {
      movies: ["Moana", "Ratatouille"],
      openVoting: true,
    });
    await hostClosesVoting(request, other(night, b));
    // Ava was at B too (G8): opening it while it's on records her, so she may rate it (#91).
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/sse-tickets") && r.ok()),
      page.goto(`/s/${b}`),
    ]);
    await hostClosesWhenSettled(request, night, night.sessionId);
    await hostClosesWhenSettled(request, night, b);

    // AC-H4.1: History opens on Mine; A's row has Ava's picks in order and "Your pick won"
    // exactly when her profile says so.
    await page.goto("/history");
    await expect(page.getByTestId("history")).toHaveAttribute("data-tab", "mine");
    await expectBottomNav(page, "History");
    await expectNoForbiddenWords(page);
    const profile = (
      await apiFromPhone(page, "GET", `/people/${await personId(page, "Ava")}/profile`)
    ).body as { nights: { session_id: string; picked_winner: boolean }[] };
    const mineA = profile.nights.find((n) => n.session_id === night.sessionId);
    expect(mineA).toBeTruthy();
    const rowA = page.getByTestId("history-row").filter({
      has: page.locator(`[href="/s/${night.sessionId}"]`),
    });
    await expect(rowA.getByTestId("history-picks")).toHaveText(
      new RegExp(`${night.movies[0]}.*${night.movies[1]}`),
    );
    await expect(rowA.getByTestId("history-won")).toHaveCount(mineA!.picked_winner ? 1 : 0);
    await expect(rowA.getByTestId("history-rate")).toHaveText("Rate it");

    // AC-H4.2: Family lists both nights with turnout; a reload keeps the tab.
    await page.getByTestId("history-tab-family").click();
    await expect(page.getByTestId("history")).toHaveAttribute("data-tab", "family");
    await expect(page.getByTestId("history-tab-family")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("history-list").getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("history-turnout").first()).toHaveText(/^\d+ voted$/);
    await page.reload();
    await expect(page.getByTestId("history")).toHaveAttribute("data-tab", "family");

    // AC-H3.3: the older night opened from History → the recap, no primary, picks + album link.
    await page.getByTestId("history-tab-mine").click();
    await rowA.locator(`[href="/s/${night.sessionId}"]`).first().click();
    await expect(screen(page, "recap")).toBeVisible();
    await expect(primary(page)).toHaveCount(0);
    const picks = page.getByTestId("recap-picks").getByRole("listitem");
    await expect(picks).toHaveCount(2);
    await expect(picks.nth(0)).toContainText(night.movies[0]);
    await expect(picks.nth(1)).toContainText(night.movies[1]);
    const winnerPick = page.getByTestId("recap-picks").locator("li[data-winner]");
    if (winnerA && night.movies.slice(0, 2).includes(winnerA)) {
      await expect(winnerPick).toHaveCount(1);
      await expect(winnerPick).toContainText(winnerA);
    } else {
      await expect(winnerPick).toHaveCount(0);
    }
    await expect(page.getByTestId("recap-photos")).toHaveAttribute(
      "href",
      `/albums/${night.sessionId}`,
    );
    await expectBottomNav(page, "Home"); // a night's screens sit under Home

    // AC-H3.2 (rated): B is the latest night; after rating it, "Back to Home" is the primary.
    await page.goto(`/s/${b}`);
    await expect(screen(page, "wrap")).toBeVisible();
    await primary(page).getByRole("radio", { name: "4 stars" }).click();
    await expect(primary(page)).toHaveText("Back to Home");
    await primary(page).click();
    await expect(screen(page, "home")).toBeVisible();

    // AC-H3.8: Stay here at 40 s dismisses the toast for that night; the wrap keeps its link.
    await page.goto(`/s/${b}`);
    await expect(screen(page, "wrap")).toBeVisible();
    await freezeClock(page);
    const c = await hostStartsNight(request, night, { movies: ["Coco", "Up"], openVoting: true });
    await stepUntil(page, isVisible(countdown(page)), { timeout: HANDOFF_WAIT + 5_000 });
    await page.clock.runFor(20_000);
    expect(await secondsLeft(page)).toBe(40);
    await handoffStay(page).click();
    await expect(toast(page)).toHaveCount(0);
    await expect(primary(page)).toHaveText("Go to tonight's movie night");
    await page.clock.runFor(120_000);
    await expect(screen(page, "wrap")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/s/${b}`);

    // …the recap of another past night in the same tab: no toast for that night, just the link.
    await page.goto(`/s/${night.sessionId}`);
    await freezeClock(page);
    // Until the latest night is known the page is That's a wrap (pastNightKind), so wait for both.
    await stepUntil(
      page,
      async () => (await screen(page, "recap").isVisible()) && (await liveLink(page).isVisible()),
    );
    await expect(toast(page)).toHaveCount(0);
    await expect(liveLink(page)).toHaveAttribute("data-night", c);

    // AC-H3.7 (+ the last clause of H3.8): a second new night brings a fresh toast at 60, and it
    // follows the phone: History and Me carry on from the same second, and the move comes from
    // wherever the phone is. Back returns there.
    const d = await hostStartsNight(request, night, { movies: ["Up", "Wall-E"], openVoting: true });
    await stepUntil(page, isVisible(countdown(page)), { timeout: HANDOFF_WAIT + 5_000 });
    await expect(toast(page)).toHaveAttribute("data-night", d);
    await expect(countdown(page)).toHaveAttribute("data-seconds", "60");
    await expect(primary(page)).toHaveCount(1);
    await page.clock.runFor(15_000);
    expect(await secondsLeft(page)).toBe(45);
    await page.clock.resume();
    await navLink(page, "history").click();
    await expect(screen(page, "history")).toBeVisible();
    await freezeClock(page);
    await expect(toast(page)).toHaveAttribute("data-night", d);
    const onHistory = await secondsLeft(page);
    expect(onHistory).toBeLessThanOrEqual(45);
    expect(onHistory).toBeGreaterThan(35);
    await page.clock.resume();
    await navLink(page, "me").click();
    await expect(screen(page, "me")).toBeVisible();
    await freezeClock(page);
    await expect(toast(page)).toBeVisible();
    await expectToastAboveNav(page);
    const onMe = await secondsLeft(page);
    expect(onMe).toBeLessThanOrEqual(onHistory);
    expect(onMe).toBeGreaterThan(30);
    await page.clock.runFor(onMe * 1_000);
    await stepUntil(page, isVisible(screen(page, "ballot")));
    expect(new URL(page.url()).pathname).toBe(`/s/${d}`);
    await backTo(page, "/me");
    await expect(screen(page, "me")).toBeVisible();
  });

  test("a night this tab has seen shows no toast and nothing moves; a new one follows the phone, and Join goes there", async ({
    page,
    request,
  }) => {
    const night = seedNight({ movies: 3, tonight: true });
    await page.clock.install();
    await joinAs(page, night, ["Ava"]);
    const leo = await personId(page, "Leo");

    // AC-H3.4: never on the night's own screen.
    await page.goto(`/s/${night.sessionId}`);
    await expect(screen(page, "tonight")).toBeVisible();
    await expect(toast(page)).toHaveCount(0);
    await expectBottomNav(page, "Home");

    // AC-H3.11: the joined night is seen, so no screen shows a toast and none moves by itself.
    const browse: [string, string, "Home" | "History" | "Me"][] = [
      ["/", "home", "Home"],
      ["/history", "history", "History"],
      ["/me", "me", "Me"],
      [`/people/${leo}`, "profile", "History"],
      [`/albums/${night.sessionId}`, "album", "Home"],
    ];
    for (const [path, id, tab] of browse) {
      await page.goto(path);
      await expect(screen(page, id)).toBeVisible();
      await expect(toast(page)).toHaveCount(0);
      if (id !== "album") await expectBottomNav(page, tab);
      await letTimePass(page, 30_000);
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(screen(page, id)).toBeVisible();
    }

    // AC-H3.4: a new night (voting open) → the toast on History, above the nav; the tabs stay
    // usable and the toast follows to Home. Join goes straight to the night (AC-H3.1, #70).
    await hostClosesNight(request, night);
    await page.goto("/history");
    await expect(screen(page, "history")).toBeVisible();
    const live = await hostStartsNight(request, night, {
      movies: ["Coco", "Up"],
      openVoting: true,
    });
    await expect(toast(page)).toBeVisible({ timeout: HANDOFF_WAIT });
    await expect(toast(page)).toHaveAttribute("data-phase", "started");
    await expectToastAboveNav(page);
    await navLink(page, "home").click();
    await expect(screen(page, "home")).toBeVisible();
    await expect(toast(page)).toHaveAttribute("data-night", live);
    await toastJoin(page).click();
    await expect(screen(page, "ballot")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/s/${live}`);
    await expect(toast(page)).toHaveCount(0);
  });

  test("History with no nights yet says so, and the nav is the way on (AC-H4.3)", async ({
    page,
  }) => {
    const night = seedNight();
    await joinAs(page, night, ["Ava"]);
    await page.goto("/history");
    await expect(page.getByTestId("history")).toHaveAttribute("data-tab", "mine");
    await expect(page.getByTestId("history-empty")).toHaveText(
      "Your movie nights will show up here after the first one.",
    );
    await page.getByTestId("history-tab-family").click();
    await expect(page.getByTestId("history-empty")).toHaveText(
      "No movie nights yet. Tonight could be the first.",
    );
    await expectBottomNav(page, "History");
    await navLink(page, "me").click();
    await expect(screen(page, "me")).toBeVisible();
  });

  test("Me: picture any number of times, name once, switching always asks for a PIN", async ({
    page,
    request,
  }) => {
    const night = seedNight({ movies: 3, tonight: true });
    await joinAs(page, night, ["Leo", "Ava"]);

    // AC-H5.1
    await page.goto("/me");
    await expect(screen(page, "me")).toBeVisible();
    await expect(page.getByTestId("me-name")).toHaveText("Ava");
    await expect(page.getByTestId("change-picture")).toBeVisible();
    await expect(page.getByTestId("profile-stats")).toBeVisible();
    await expect(page.getByTestId("me-switch")).toBeVisible();
    await expect(page.getByTestId("me-pin")).toBeVisible();
    await expect(page.getByTestId("me-rename")).toBeVisible();
    await expectBottomNav(page, "Me");
    await expectNoForbiddenWords(page);

    // AC-H5.4: your own profile is Me.
    await page.goto(`/people/${await personId(page, "Ava")}`);
    await expect(page).toHaveURL(/\/me$/);

    // AC-H5.3 / AC-H5.5: three picture changes in a row, one PATCH each, the app bar follows.
    const patches: number[] = [];
    page.on("response", (response) => {
      // Picture changes only: the rename is a PATCH to the same path.
      if (
        response.request().method() === "PATCH" &&
        /\/api\/v1\/devices\/me\/people\/[^/]+$/.test(response.url()) &&
        (response.request().postData() ?? "").includes("avatar_emoji")
      ) {
        patches.push(response.status());
      }
    });
    const bodies: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && /\/devices\/me\/people\//.test(req.url())) {
        bodies.push(req.postData() ?? "");
      }
    });
    for (const emoji of ["🐙", "🦊", "🐸"]) {
      await page.getByTestId("change-picture").click();
      const sheet = page.getByTestId("picture-sheet");
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: `Picture ${emoji}` }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByTestId("app-bar-person")).toContainText(emoji);
      // Me's big avatar sits beside the Change picture button.
      await expect(page.getByTestId("change-picture").locator("xpath=..")).toContainText(emoji);
    }
    await expect.poll(() => patches).toEqual([200, 200, 200]);
    expect(bodies.map((b) => JSON.parse(b) as Record<string, unknown>)).toEqual([
      { avatar_emoji: "🐙" },
      { avatar_emoji: "🦊" },
      { avatar_emoji: "🐸" },
    ]);
    // The picture never spends the one rename.
    await expect(page.getByTestId("me-rename")).toBeVisible();

    // …and after the rename, the picture still changes.
    await page.getByTestId("me-rename").click();
    await page.getByLabel("Your name").fill("Avery");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByTestId("me-name")).toHaveText("Avery");
    await expect(page.getByTestId("me-rename")).toHaveCount(0);
    await page.getByTestId("change-picture").click();
    await page.getByTestId("picture-sheet").getByRole("button", { name: "Picture 🦁" }).click();
    await expect(page.getByTestId("picture-sheet")).toHaveCount(0);
    await expect(page.getByTestId("app-bar-person")).toContainText("🦁");
    await expect.poll(() => patches).toEqual([200, 200, 200, 200]);

    // AC-H5.2 / AC-H0.3: Switch person asks for Leo's PIN; a wrong one changes nothing.
    await page.getByTestId("me-switch").click();
    const sheet = page.getByTestId("switch-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /^Leo/ }).click();
    await expect(page.getByTestId("pin-sheet")).toBeVisible();
    await typePin(page, "000000"); // nobody's PIN (support/phones.ts PINS)
    await expect(page.getByTestId("pin-input")).toHaveValue("");
    expect(await currentName(page)).toBe("Avery");
    await typePin(page, pinFor("Leo"));
    // A right PIN with a live night is an arrival: the night's own screen.
    await expect(page).toHaveURL(new RegExp(`/s/${night.sessionId}$`));
    await expect(screen(page, "tonight")).toBeVisible();
    expect(await currentName(page)).toBe("Leo");

    // AC-H0.3: the app bar's person button opens the same sheet.
    await page.getByTestId("app-bar-person").click();
    await expect(page.getByTestId("switch-sheet")).toBeVisible();
    await page.keyboard.press("Escape");

    // With no live night the arrival lands on Home, without `arrive` in the URL.
    await hostClosesNight(request, night);
    await page.goto("/me");
    await page.getByTestId("me-switch").click();
    await page
      .getByTestId("switch-sheet")
      .getByRole("button", { name: /^Avery/ })
      .click();
    await typePin(page, pinFor("Ava"));
    await expect(screen(page, "home")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(await currentName(page)).toBe("Avery");
  });
});
