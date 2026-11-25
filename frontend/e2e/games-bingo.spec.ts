import { expectNoAxeViolations, pairAsTv, signInAsHost } from "./support/host";
import { joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * Thanksgiving Bingo (ADR-0018 slice B): the host creates a round, opens it, a phone takes a seat
 * and gets a card, the host starts the round, and the phone marks the top row. The completing mark
 * wins (no buzz button) and ends the round; the TV shows the winner but never a square. Every wait
 * is on a server-confirmed state (`data-live`, `data-status`).
 */
test.describe("thanksgiving bingo", () => {
  test("play a round on a phone and watch the win on the TV", async ({
    browser,
    page,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });

    // Host: create the round (a draft) and open it for players.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const host = await hostContext.newPage();
    await host.goto("/host/games");
    await host.getByTestId("bingo-title").fill("E2E bingo");
    await host.getByTestId("create-bingo").click();
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    const hostGame = host.getByTestId("host-game");
    await expect(hostGame).toHaveAttribute("data-live", "ready", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "draft");
    await host.getByTestId("open-game").click();
    await expect(hostGame).toHaveAttribute("data-status", "open", POLL);

    // TV: a paired browser on the game's screen. It lists players, never squares.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-bingo")).toHaveAttribute("data-live", "ready", POLL);
    await expect(tv.getByTestId("tv-bingo-player")).toHaveCount(0);

    // Phone: join as the first person and take a seat.
    await joinAs(page, night, [night.people[0]]);
    await page.goto("/games");
    await expect(page.getByTestId("game-card")).toHaveCount(1);
    await expectNoAxeViolations(page);
    await page.getByTestId("game-card").click();
    const screen = page.getByTestId("game-screen");
    await expect(screen).toHaveAttribute("data-live", "ready", POLL);
    await page.getByTestId("primary-action").click();
    await expect(page.getByTestId("bingo-square")).toHaveCount(25);
    await expect(page.getByTestId("bingo-square").nth(12)).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page);
    await expect(host.getByTestId("host-bingo-player")).toHaveCount(1, POLL);
    await expect(tv.getByTestId("tv-bingo-player")).toHaveCount(1, POLL);

    // Open but not live: squares are not tappable yet.
    await expect(page.getByTestId("bingo-square").nth(0)).toBeDisabled();
    await host.getByTestId("start-round").click();
    await expect(screen).toHaveAttribute("data-status", "live", POLL);

    // Mark the top row: four marks, then the fifth completes it.
    for (let i = 0; i < 4; i++) {
      const square = page.getByTestId("bingo-square").nth(i);
      await square.click();
      await expect(square).toHaveAttribute("aria-pressed", "true", POLL);
    }
    await expect(page.getByTestId("bingo-progress")).toContainText("1 away", POLL);
    await expect(tv.getByTestId("tv-bingo-player")).toContainText("1 away", POLL);
    await page.getByTestId("bingo-square").nth(4).click();

    // The server decided: the round is over and everyone sees who won.
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("bingo-announcement")).toContainText("got bingo", POLL);
    await expect(tv.getByTestId("tv-bingo-winner")).toContainText("got bingo", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("bingo-square").nth(0)).toBeDisabled();
    await expectNoAxeViolations(page);
  });
});
