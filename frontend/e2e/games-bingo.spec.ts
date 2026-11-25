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
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await hub.getByTestId("bingo-title").fill("E2E bingo");
    // The form preselects classic this year; this spec plays the Thanksgiving mode.
    await hub.getByTestId("bingo-mode-thanksgiving").check();
    // This spec also covers a non-default pattern: the four corners win.
    await hub.getByTestId("win-mode-corners").check();
    // Creating a game opens its control page in a new tab; the hub tab stays put.
    const [host] = await Promise.all([
      hub.waitForEvent("popup"),
      hub.getByTestId("create-bingo").click(),
    ]);
    await expect(hub).toHaveURL(/\/host\/games$/);
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
    // The title stays centred in the window even while the Full screen corner shows.
    const heading = await tv.getByRole("heading", { level: 1 }).boundingBox();
    const width = tv.viewportSize()?.width ?? 0;
    expect(Math.abs(heading!.x + heading!.width / 2 - width / 2)).toBeLessThan(8);
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

    // A player can swap for a new card until the host starts the round.
    const squares = page.getByTestId("bingo-square");
    const before = (await squares.allTextContents()).join(",");
    await page.getByTestId("bingo-reroll").click();
    await expect(page.getByTestId("bingo-hint")).toHaveText("You have a new card.", POLL);
    expect((await squares.allTextContents()).join(",")).not.toBe(before);
    await expect(squares.nth(12)).toHaveAttribute("aria-pressed", "true");

    await host.getByTestId("start-round").click();
    await expect(screen).toHaveAttribute("data-status", "live", POLL);
    await expect(page.getByTestId("bingo-reroll")).toHaveCount(0);

    // Mark three corners; the fourth completes the pattern.
    await expect(tv.getByTestId("tv-bingo-mode")).toContainText("Four corners", POLL);
    for (const i of [0, 4, 20]) {
      const square = page.getByTestId("bingo-square").nth(i);
      await square.click();
      await expect(square).toHaveAttribute("aria-pressed", "true", POLL);
    }
    await expect(page.getByTestId("bingo-progress")).toContainText("1 away", POLL);
    await expect(tv.getByTestId("tv-bingo-player")).toContainText("1 away", POLL);
    await page.getByTestId("bingo-square").nth(24).click();

    // The server decided: the round is over and everyone sees who won.
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("bingo-announcement")).toContainText("got bingo", POLL);
    await expect(tv.getByTestId("tv-bingo-winner")).toContainText("got bingo", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("bingo-square").nth(0)).toBeDisabled();
    await expectNoAxeViolations(page);
  });
});
