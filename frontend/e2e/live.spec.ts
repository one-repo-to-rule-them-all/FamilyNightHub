import { type Browser, type BrowserContext, type Page } from "@playwright/test";

import { castPhoneBallot, pairAsTv, signInAsHost } from "./support/host";
import { expectNoAxeViolations, hostClosesVoting, joinAs, newPhone } from "./support/phones";
import { expect, seedNight, type SeededNight, test } from "./support/seed";

/**
 * Live updates (ADR-0004). While `data-live="ready"` the screens don't poll at all (the 5s
 * snapshot poll runs only while the stream is down), so a change that shows up within a window
 * shorter than one poll can only have arrived as a stream event.
 */
const LIVE = { timeout: 4_000 };
/** Down-stream recovery: one 5s poll plus margin. */
const POLL = { timeout: 15_000 };

const STREAM_ROUTE = "**/api/v1/sessions/*/stream**";

/** Pairs a fresh 1280x720 browser as the household's TV; /tv follows the seeded night. */
async function pairTv(browser: Browser, night: SeededNight, origin: string) {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 720 },
    // The reveal lands on the winner at once instead of spinning first.
    reducedMotion: "reduce",
  });
  await signInAsHost(context, night, origin);
  const tv = await context.newPage();
  await pairAsTv(tv);
  await expect(tv).toHaveURL(new RegExp(`/tv/${night.sessionId}$`));
  return { context, tv };
}

const liveRoot = (page: Page) => page.locator("[data-live]").first();

async function expectLive(page: Page, state: "ready" | "reconnecting", options = {}) {
  await expect(liveRoot(page)).toHaveAttribute("data-live", state, options);
}

test.describe("live updates", () => {
  test("two phones and the TV see the ballot count and the reveal as they happen", async ({
    browser,
    page,
    request,
    baseURL,
  }) => {
    test.slow(); // three browsers
    const night = seedNight({ movies: 3, openVoting: true });
    const [paddington] = night.movies;
    const total = night.people.length;

    const { context: tvContext, tv } = await pairTv(browser, night, baseURL as string);
    await joinAs(page, night, ["Ava"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    for (const phone of [page, phoneB]) await phone.goto(`/s/${night.sessionId}`);

    // Every screen is on the stream before anything changes.
    for (const screen of [page, phoneB, tv]) await expectLive(screen, "ready");
    await expect(tv.getByTestId("tv-headline")).toHaveText(`0 of ${total} voted`);
    await expect(tv.getByTestId("tv-live-status")).toHaveCount(0);
    await expectNoAxeViolations(tv);

    // Each ballot reaches the TV as a ballot_count event.
    expect(await castPhoneBallot(page, night.sessionId, "Ava", [paddington!])).toBe(204);
    await expect(tv.getByTestId("tv-headline")).toHaveText(`1 of ${total} voted`, LIVE);
    const avaTile = tv.getByTestId("tv-tile").and(tv.locator('[data-person="Ava"]'));
    await expect(avaTile).toHaveAttribute("data-voted", "true", LIVE);
    expect(await castPhoneBallot(phoneB, night.sessionId, "Leo", [paddington!])).toBe(204);
    await expect(tv.getByTestId("tv-headline")).toHaveText(`2 of ${total} voted`, LIVE);

    // The host closes; both phones and the TV land on the server's winner.
    const closed = await hostClosesVoting(request, night);
    const winner = closed.options.find((o) => o.id === closed.result?.winner_option_id)?.title;
    expect(winner).toBe(paddington);
    for (const phone of [page, phoneB]) {
      await expect(phone.getByTestId("winner-title")).toHaveText(paddington!, LIVE);
      await expect(phone.getByTestId("ballot-count")).toHaveText("2 people voted");
    }
    await expect(tv.getByTestId("tv-winner")).toBeVisible(LIVE);
    await expect(tv.getByRole("heading", { name: paddington })).toBeVisible();
    await expectNoAxeViolations(page);

    await phoneB.context().close();
    await tvContext.close();
  });

  test("a phone whose stream dies mid-vote recovers through polling, then goes live again", async ({
    page,
    request,
    browser,
  }) => {
    const night = seedNight({ movies: 3, openVoting: true });
    const [paddington] = night.movies;
    await joinAs(page, night, ["Ava"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);

    await page.addInitScript(trackStreams);
    await page.goto(`/s/${night.sessionId}`);
    await expectLive(page, "ready");
    expect(await castPhoneBallot(page, night.sessionId, "Ava", [paddington!])).toBe(204);

    // Mid-vote the stream dies (the phone drops off the network) and can't come back.
    await page.route(STREAM_ROUTE, (route) => route.abort("connectionreset"));
    await page.evaluate(() => (window as unknown as StreamTracker).__dropStreams());
    await expectLive(page, "reconnecting");
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "voting");

    // Voting carries on without it; the reveal still reaches this phone, by polling.
    expect(await castPhoneBallot(phoneB, night.sessionId, "Leo", [paddington!])).toBe(204);
    await hostClosesVoting(request, night);
    await expect(page.getByTestId("winner-title")).toHaveText(paddington!, POLL);
    await expect(page.getByTestId("ballot-count")).toHaveText("2 people voted");
    await expectLive(page, "reconnecting");

    // The stream is reachable again and the network comes back: the phone re-tickets at once.
    await page.unroute(STREAM_ROUTE);
    await backOnline(page.context());
    await expectLive(page, "ready", POLL);
    await expectNoAxeViolations(page);

    await phoneB.context().close();
  });
});

type StreamTracker = { __dropStreams: () => void };

/**
 * Init script: remembers every EventSource the page opens so the test can drop them the way the
 * browser reports a lost stream (closed, then an `error` event). Emulating offline doesn't do it:
 * Chromium leaves an already-open stream alone.
 */
function trackStreams() {
  const Native = window.EventSource;
  const opened: EventSource[] = [];
  class Tracked extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      opened.push(this);
    }
  }
  window.EventSource = Tracked;
  (window as unknown as StreamTracker).__dropStreams = () => {
    for (const source of opened.splice(0)) {
      if (source.readyState === Native.CLOSED) continue;
      source.close();
      source.dispatchEvent(new Event("error"));
    }
  };
}

/** The network blips and returns: the browser fires `online`, the hook's cue to reconnect now. */
async function backOnline(context: BrowserContext) {
  await context.setOffline(true);
  await context.setOffline(false);
}
