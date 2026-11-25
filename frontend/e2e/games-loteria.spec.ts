import { expectNoAxeViolations, pairAsTv, signInAsHost } from "./support/host";
import { apiFromPhone, joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * Lotería (ADR-0018 amendment 2026-11-26): the host draws pictures, the phone can mark only a
 * called one, a tabla can be rerolled until the host starts, a false "¡Lotería!" is checked and
 * leaves the game running, then a true one ends it. Every wait is on a server-confirmed state
 * (`data-live`, `data-status`, the called count).
 */
test.describe("loteria", () => {
  test("host draws, a phone rerolls then marks only called pictures, a false then a true check", async ({
    browser,
    page,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });

    // Host: create the round from the Games hub and open it.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await hub.getByTestId("loteria-title").fill("E2E Loteria");
    const [host] = await Promise.all([
      hub.waitForEvent("popup"),
      hub.getByTestId("create-loteria").click(),
    ]);
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    const hostGame = host.getByTestId("host-game");
    await expect(hostGame).toHaveAttribute("data-live", "ready", POLL);
    await expect(hostGame).toHaveAttribute("data-pattern", "line");
    await host.getByTestId("open-game").click();
    await expect(hostGame).toHaveAttribute("data-status", "open", POLL);

    // TV: a paired browser on the game's screen.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-loteria")).toHaveAttribute("data-live", "ready", POLL);

    // Phone: take a seat, get a tabla of 16 pictures, then reroll it while the game is open.
    await joinAs(page, night, [night.people[0]]);
    await page.goto("/games");
    await page.getByTestId("game-card").click();
    const screen = page.getByTestId("game-screen");
    await expect(screen).toHaveAttribute("data-live", "ready", POLL);
    await page.getByTestId("primary-action").click();
    const squares = page.getByTestId("loteria-square");
    await expect(squares).toHaveCount(16);
    const cardIds = () =>
      squares.evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-card-id"))));
    const first = await cardIds();
    expect(new Set(first).size).toBe(16);
    await page.getByTestId("loteria-reroll").click();
    await expect.poll(cardIds, POLL).not.toEqual(first);
    const ids = await cardIds();
    await expect(host.getByTestId("host-loteria-player")).toHaveCount(1, POLL);

    // Round starts: rerolling is gone, and nothing is called yet so nothing is markable.
    await host.getByTestId("start-round").click();
    await expect(screen).toHaveAttribute("data-status", "live", POLL);
    await expect(page.getByTestId("loteria-reroll")).toHaveCount(0);
    await expect(host.getByTestId("host-draw")).toBeVisible(POLL);
    await expect(squares.nth(0)).toHaveAttribute("aria-disabled", "true");

    // Host draws until a picture on this tabla has been called (never more than 54 draws).
    let drawn = 0;
    let hit: number | null = null;
    while (hit === null && drawn < 54) {
      await host.getByTestId("host-draw").click();
      drawn += 1;
      await expect(host.getByTestId("host-last-call")).toHaveAttribute("data-card-id", /\d+/, POLL);
      await expect(host.getByTestId("loteria-called-board")).toHaveAttribute(
        "data-count",
        String(drawn),
        POLL,
      );
      const id = Number(await host.getByTestId("host-last-call").getAttribute("data-card-id"));
      if (ids.includes(id)) hit = id;
    }
    expect(hit).not.toBeNull();
    await expect(tv.getByTestId("tv-loteria-last")).toHaveAttribute(
      "data-card-id",
      String(hit),
      POLL,
    );
    await expect(tv.getByTestId("loteria-called-board")).toHaveAttribute(
      "data-count",
      String(drawn),
      POLL,
    );
    await expect(page.getByTestId("loteria-last")).toHaveAttribute(
      "data-card-id",
      String(hit),
      POLL,
    );

    // Phone: the called picture marks; an uncalled one is inactive and a tap says why.
    const called = squares.nth(ids.indexOf(hit!));
    await expect(called).toHaveAttribute("data-called", "true", POLL);
    await called.click();
    await expect(called).toHaveAttribute("aria-pressed", "true", POLL);
    const uncalledIndex = await squares.evaluateAll((els) =>
      els.findIndex((el) => el.getAttribute("aria-disabled") === "true"),
    );
    expect(uncalledIndex).toBeGreaterThanOrEqual(0);
    const uncalled = squares.nth(uncalledIndex);
    // aria-disabled keeps the button focusable (a tap says why); Playwright counts it as disabled.
    await uncalled.click({ force: true });
    await expect(page.getByTestId("loteria-hint")).toContainText("hasn't been called", POLL);
    await expect(uncalled).toHaveAttribute("aria-pressed", "false");
    await expectNoAxeViolations(page);

    // A false "¡Lotería!": the host checks, hears "not yet", and the game goes on.
    const row = host.getByTestId("host-check-row");
    await row.getByTestId("host-check-loteria").click();
    await expect(row.getByTestId("host-check-result")).toContainText("not yet", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "live");

    // Call the tabla's top row (through the host's own session) and check again: valid, game over.
    const topRow = new Set(ids.slice(0, 4));
    let calledNow = await host
      .getByTestId("loteria-called-cell")
      .evaluateAll((els) =>
        els
          .filter((el) => el.getAttribute("data-called") === "true")
          .map((el) => Number(el.getAttribute("data-card-id"))),
      );
    while (![...topRow].every((v) => calledNow.includes(v)) && drawn < 54) {
      const resp = await apiFromPhone(host, "POST", `/games/${gameId}/loteria/draw`, {
        expected_seq: drawn,
      });
      expect(resp.status).toBe(200);
      const calls = (resp.body as { loteria: { calls: { card_id: number }[] } }).loteria.calls;
      calledNow = calls.map((c) => c.card_id);
      drawn = calls.length;
    }
    await expect(host.getByTestId("loteria-called-board")).toHaveAttribute(
      "data-count",
      String(drawn),
      POLL,
    );
    await row.getByTestId("host-check-loteria").click();
    await expect(row.getByTestId("host-check-result")).toContainText("valid", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "ended", POLL);
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("loteria-announcement")).toContainText("got ¡Lotería!", POLL);
    await expect(tv.getByTestId("tv-loteria-winner")).toContainText("got ¡Lotería!", POLL);
  });
});
