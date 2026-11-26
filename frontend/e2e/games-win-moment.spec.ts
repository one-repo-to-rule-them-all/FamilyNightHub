import type { Page } from "@playwright/test";

import { pairAsTv, signInAsHost } from "./support/host";
import { apiFromPhone, joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * The win and lose moment (ADR-0018 amendment 2026-11-26) in a Lotería round: two phones play,
 * the host draws one phone's top row and checks it. The winner's phone shows "You won!" with
 * confetti, the other "Maybe next time"; both close with the big button and do not replay on
 * reload. A third, reduced-motion device for the winner gets the still version (no confetti).
 */
test.describe("games win moment", () => {
  test("winner sees You won!, the other phone Maybe next time, reduced motion has no confetti", async ({
    browser,
    page,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });
    const [winnerName, loserName] = [night.people[0], night.people[1]];

    // Host: a Lotería round on the line pattern, opened.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await hub.getByTestId("loteria-title").fill("E2E Win moment");
    await hub.getByTestId("loteria-pattern-line").check();
    const [host] = await Promise.all([
      hub.waitForEvent("popup"),
      hub.getByTestId("create-loteria").click(),
    ]);
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    const hostGame = host.getByTestId("host-game");
    await expect(hostGame).toHaveAttribute("data-live", "ready", POLL);
    await host.getByTestId("open-game").click();
    await expect(hostGame).toHaveAttribute("data-status", "open", POLL);

    // TV: confetti over the winner banner.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-loteria")).toHaveAttribute("data-live", "ready", POLL);

    // Two phones take a tabla each.
    const loserContext = await browser.newContext({ baseURL: origin });
    const loser = await loserContext.newPage();
    const takeTabla = async (phone: Page, name: string) => {
      await joinAs(phone, night, [name]);
      await phone.goto(`/games/${gameId}`);
      await expect(phone.getByTestId("game-screen")).toHaveAttribute("data-live", "ready", POLL);
      await phone.getByTestId("primary-action").click();
      await expect(phone.getByTestId("loteria-square")).toHaveCount(16, POLL);
    };
    await takeTabla(page, winnerName);
    await takeTabla(loser, loserName);
    const topRow = (
      await page
        .getByTestId("loteria-square")
        .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-card-id"))))
    ).slice(0, 4);
    await expect(host.getByTestId("host-loteria-player")).toHaveCount(2, POLL);

    // Start, then draw (through the host's session) until the winner's top row is called.
    await host.getByTestId("start-round").click();
    await expect(hostGame).toHaveAttribute("data-status", "live", POLL);
    let drawn = 0;
    let called: number[] = [];
    while (!topRow.every((id) => called.includes(id)) && drawn < 54) {
      const resp = await apiFromPhone(host, "POST", `/games/${gameId}/loteria/draw`, {
        expected_seq: drawn,
      });
      expect(resp.status).toBe(200);
      const calls = (resp.body as { loteria: { calls: { card_id: number }[] } }).loteria.calls;
      called = calls.map((c) => c.card_id);
      drawn = calls.length;
    }

    // Nothing shows while the game is live.
    await expect(page.getByTestId("result-moment")).toHaveCount(0);

    // The host checks the winner: valid, game over.
    const row = host.getByTestId("host-check-row").filter({ hasText: winnerName });
    await expect(row.getByTestId("host-check-loteria")).toBeEnabled(POLL);
    await row.getByTestId("host-check-loteria").click();
    await expect(row.getByTestId("host-check-result")).toContainText("valid", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "ended", POLL);

    // Winner: You won! with the pattern and confetti; closes with the big button.
    const won = page.getByTestId("result-won");
    await expect(won).toBeVisible(POLL);
    await expect(won).toContainText("You won!");
    await expect(won).toContainText("Line");
    await expect(page.getByTestId("confetti")).toBeAttached();
    await expect(tv.getByTestId("tv-confetti")).toBeAttached(POLL);

    // Loser: a kind Maybe next time that says who won; Escape closes it.
    const lost = loser.getByTestId("result-lost");
    await expect(lost).toBeVisible(POLL);
    await expect(lost).toContainText("Maybe next time");
    await expect(lost).toContainText(`${winnerName} won this one.`);
    await expect(loser.getByTestId("confetti")).toHaveCount(0);
    await loser.keyboard.press("Escape");
    await expect(loser.getByTestId("result-moment")).toHaveCount(0);

    await page.getByTestId("result-dismiss").click();
    await expect(page.getByTestId("result-moment")).toHaveCount(0);

    // Shown once per person per game on a device: a reload keeps only the result line.
    await page.reload();
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("loteria-announcement")).toContainText(winnerName, POLL);
    // The guard key was written when the card first showed, so the effect finds it and stays shut.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((k) => k.startsWith("fn:result-moment:")),
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("result-moment")).toHaveCount(0);

    // A reduced-motion device for the winner: the still version, no confetti.
    const stillContext = await browser.newContext({ baseURL: origin, reducedMotion: "reduce" });
    const still = await stillContext.newPage();
    await joinAs(still, night, [winnerName]);
    await still.goto(`/games/${gameId}`);
    await expect(still.getByTestId("result-won")).toBeVisible(POLL);
    await expect(still.getByTestId("confetti")).toHaveCount(0);
    await still.getByTestId("result-dismiss").click();
    await expect(still.getByTestId("result-moment")).toHaveCount(0);

    await Promise.all([
      hostContext.close(),
      tvContext.close(),
      loserContext.close(),
      stillContext.close(),
    ]);
  });
});
