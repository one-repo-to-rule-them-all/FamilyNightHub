import { expectNoAxeViolations, signInAsHost } from "./support/host";
import { joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * Gratitude Jar (ADR-0018 slice A): the host starts a jar, a phone drops a note (one named, one
 * anonymous), the host starts the reveal, and the notes appear one at a time on the phone and
 * the TV screen. Every wait is on a server-confirmed state (`data-live`, `data-status`).
 */
test.describe("gratitude jar", () => {
  test("drop notes on a phone, reveal them one by one on the TV", async ({
    browser,
    page,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2, pins: true });

    // Host: start the jar.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const host = await hostContext.newPage();
    await host.goto("/host/games");
    await host.getByTestId("game-title").fill("E2E jar");
    await host.getByTestId("create-game").click();
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
    const tv = await hostContext.newPage();
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-jar")).toHaveAttribute("data-live", "ready", POLL);
    await expect(tv.getByTestId("tv-note")).toHaveCount(0);

    // Reveal: nothing on the TV until the host shows a note.
    await host.getByTestId("start-reveal").click();
    await expect(screen).toHaveAttribute("data-status", "live", POLL);
    await expect(tv.getByTestId("tv-note")).toHaveCount(0);
    await host.getByTestId("reveal-next").click();
    await expect(tv.getByTestId("tv-note")).toHaveCount(1, POLL);
    await expect(page.getByTestId("jar-note")).toHaveCount(1, POLL);
    await host.getByTestId("reveal-next").click();
    await expect(page.getByTestId("jar-progress")).toContainText("2 of 2 revealed", POLL);
    await expect(tv.getByTestId("tv-jar-progress")).toContainText("2 of 2 revealed", POLL);

    await host.getByTestId("end-game").click();
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
  });
});
