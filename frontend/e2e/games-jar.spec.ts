import { expectNoAxeViolations, pairAsTv, signInAsHost } from "./support/host";
import { joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * Gratitude Jar (ADR-0018, amendment part B): the host starts a jar (5 seconds a note), a phone
 * drops two notes (one named, one anonymous), the host presses Start, and the notes then cycle on
 * the phone and the TV with no further click. Pause holds both; End finishes. Every wait is on a
 * server-confirmed state (`data-live`, `data-status`) or on the cycle itself.
 */
test.describe("gratitude jar", () => {
  test("drop notes on a phone, then they cycle by themselves on the phone and the TV", async ({
    browser,
    page,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });

    // Host: start the jar.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await hub.getByTestId("game-title").fill("E2E jar");
    await hub.getByTestId("jar-cycle-seconds").fill("5");
    // Creating a game opens its control page in a new tab; the hub tab stays put.
    const [host] = await Promise.all([
      hub.waitForEvent("popup"),
      hub.getByTestId("create-game").click(),
    ]);
    await expect(hub).toHaveURL(/\/host\/games$/);
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    await expect(host.getByTestId("host-game")).toHaveAttribute("data-live", "ready", POLL);

    // Phone: join as Ava, open the Games tab, drop two notes.
    await joinAs(page, night, [night.people[0]]);
    await page.goto("/games");
    await expect(page.getByTestId("game-card")).toHaveCount(1);
    await expectNoAxeViolations(page);
    await page.getByTestId("game-card").click();
    const screen = page.getByTestId("game-screen");
    await expect(screen).toHaveAttribute("data-live", "ready", POLL);
    await page.getByTestId("jar-note-input").fill("Grandma's pie");
    await page.getByTestId("primary-action").click();
    await expect(page.getByTestId("my-note")).toHaveCount(1);
    await page.getByTestId("jar-note-input").fill("Everyone being home");
    await page.getByTestId("jar-anonymous").check();
    await page.getByTestId("primary-action").click();
    await expect(page.getByTestId("my-note")).toHaveCount(2);
    await expectNoAxeViolations(page);

    // The host sees the text before it shows, and never an anonymous author.
    await expect(host.getByTestId("moderation-note")).toHaveCount(2, POLL);
    await expect(host.getByText("Name kept off")).toBeVisible();

    // TV: a second window on the game's screen.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-jar")).toHaveAttribute("data-live", "ready", POLL);
    await expect(tv.getByTestId("tv-note")).toHaveCount(0);

    // Start: nothing on the TV until the host presses it, then it cycles with no more clicks.
    await expect(host.getByTestId("jar-start-warning")).toBeVisible();
    await host.getByTestId("start-reveal").click();
    await expect(screen).toHaveAttribute("data-status", "live", POLL);
    await expect(tv.getByTestId("tv-note")).toHaveCount(1, POLL);
    await expect(page.getByTestId("jar-note")).toHaveCount(1, POLL);
    const first = await tv.getByTestId("tv-note").innerText();
    // Two notes at 5 s each: the other note shows up by itself.
    await expect.poll(async () => tv.getByTestId("tv-note").innerText(), POLL).not.toBe(first);
    await expect(tv.getByTestId("tv-jar-progress")).toContainText("of 2");
    await expect(page.getByTestId("jar-cycle-counter")).toContainText("of 2");
    // A note fades in on every change; scan once the (finite) animations have settled, or axe
    // reads the half-transparent text as low contrast.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished),
      ),
    );
    await expectNoAxeViolations(page);

    // Pause holds the note on both screens; Resume lets it go on.
    await host.getByTestId("jar-pause").click();
    await expect(tv.getByTestId("tv-jar-paused")).toBeVisible(POLL);
    await expect(page.getByTestId("jar-paused")).toBeVisible(POLL);
    const held = await tv.getByTestId("tv-note").innerText();
    // The paused badge is the server-confirmed state; the note on screen is the one being held.
    await expect.poll(async () => tv.getByTestId("tv-note").innerText()).toBe(held);
    await host.getByTestId("jar-resume").click();
    await expect(tv.getByTestId("tv-jar-paused")).toHaveCount(0, POLL);

    await host.getByTestId("end-game").click();
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
  });
});
