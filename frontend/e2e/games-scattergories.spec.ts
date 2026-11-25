import { expectNoAxeViolations, pairAsTv, signInAsHost } from "./support/host";
import { joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * Thanksgiving Scattergories (ADR-0018 slice C): the host starts a game and a round, a phone
 * joins and answers, the host reveals early, and the answers, a point and the leaderboard show on
 * the phone and the TV. The countdown is local against the server's `ends_at`, so the spec never
 * waits for it: it reveals early. Every wait is on a server-confirmed state (`data-live`,
 * `data-round-state`).
 */
test.describe("scattergories", () => {
  test("play a round on a phone and reveal it on the TV", async ({ browser, page, baseURL }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });

    // Host: start the game.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const host = await hostContext.newPage();
    await host.goto("/host/games");
    await host.getByTestId("create-scatter").click();
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    const hostScreen = host.getByTestId("host-game");
    await expect(hostScreen).toHaveAttribute("data-live", "ready", POLL);

    // Phone: join as Ava.
    await joinAs(page, night, [night.people[0]]);
    await page.goto("/games");
    await expect(page.getByTestId("game-card")).toHaveCount(1);
    await expectNoAxeViolations(page);
    await page.getByTestId("game-card").click();
    const screen = page.getByTestId("game-screen");
    await expect(screen).toHaveAttribute("data-live", "ready", POLL);
    await expect(screen).toHaveAttribute("data-round-state", "lobby");
    await page.getByTestId("primary-action").click();
    await expect(host.getByTestId("host-scatter-status")).toContainText("1 player", POLL);

    // TV: a second window on the game's screen.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-scatter")).toHaveAttribute("data-live", "ready", POLL);

    // Host: two categories, start the round.
    await host.getByTestId("scatter-categories").fill("Pie flavors\nSide dishes");
    await host.getByTestId("scatter-start").click();
    await expect(screen).toHaveAttribute("data-round-state", "running", POLL);
    await expect(tv.getByTestId("tv-scatter")).toHaveAttribute("data-round-state", "running", POLL);
    await expect(page.getByTestId("scatter-countdown")).toBeVisible();
    await expectNoAxeViolations(page);

    // Phone: answer both categories with words that start with the round's letter.
    const letter = ((await page.getByTestId("scatter-letter").textContent()) ?? "").trim();
    expect(letter).toMatch(/^[A-Z]$/);
    await page.getByTestId("scatter-input-0").fill(`${letter}ie`);
    await page.getByTestId("scatter-input-1").fill(`${letter}am`);
    await page.getByTestId("primary-action").click();
    await expect(page.getByTestId("scatter-saved")).toContainText("Saved", POLL);

    // Nobody sees an answer before the reveal: the host sees only that Ava answered.
    await expect(host.getByTestId("scatter-player")).toContainText("2 of 2 answered", POLL);
    await expect(host.getByText(`${letter}ie`)).toHaveCount(0);
    await expect(tv.getByText(`${letter}ie`)).toHaveCount(0);

    // Reveal early: answers, scores and the leaderboard appear on every screen.
    await host.getByTestId("scatter-reveal").click();
    await expect(screen).toHaveAttribute("data-round-state", "revealed", POLL);
    await expect(tv.getByTestId("tv-scatter")).toHaveAttribute(
      "data-round-state",
      "revealed",
      POLL,
    );
    await expect(tv.getByTestId("scatter-answer")).toHaveCount(2, POLL);
    await expect(tv.getByTestId("scatter-answer").first()).toHaveAttribute("data-point", "1");
    await expect(page.getByTestId("scatter-standing-points").first()).toContainText("2 pts", POLL);
    await expectNoAxeViolations(page);

    // The host rejects one answer: the score re-derives for everyone.
    await host.getByTestId("reject-answer").first().click();
    await expect(page.getByTestId("scatter-standing-points").first()).toContainText("1 pt", POLL);
    await expect(tv.getByTestId("scatter-standing-points").first()).toContainText("1 pt", POLL);

    await host.getByTestId("end-game").click();
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
  });
});
