import { expectNoAxeViolations, pairAsTv, signInAsHost } from "./support/host";
import { apiFromPhone, joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

/**
 * Classic bingo (ADR-0018 amendment 2026-11-25, part A): the host draws numbers, the phone can
 * mark only a called number, a false "bingo" is checked and leaves the game running, then a true
 * one ends it. The host form preselects classic. Every wait is on a server-confirmed state
 * (`data-live`, `data-status`, the called count).
 */
test.describe("classic bingo", () => {
  test("host draws, a phone marks only called numbers, a false then a true check", async ({
    browser,
    page,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });

    // Host: classic is preselected; create the round and open it.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await expect(hub.getByTestId("bingo-mode-classic")).toBeChecked();
    await hub.getByTestId("bingo-title").fill("E2E classic bingo");
    const [host] = await Promise.all([
      hub.waitForEvent("popup"),
      hub.getByTestId("create-bingo").click(),
    ]);
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    const hostGame = host.getByTestId("host-game");
    await expect(hostGame).toHaveAttribute("data-live", "ready", POLL);
    await expect(hostGame).toHaveAttribute("data-mode", "classic");
    await host.getByTestId("open-game").click();
    await expect(hostGame).toHaveAttribute("data-status", "open", POLL);

    // TV: a paired browser on the game's screen.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto(`/tv/games/${gameId}`);
    await expect(tv.getByTestId("tv-bingo")).toHaveAttribute("data-live", "ready", POLL);

    // Phone: take a seat and get a card of numbers.
    await joinAs(page, night, [night.people[0]]);
    await page.goto("/games");
    await page.getByTestId("game-card").click();
    const screen = page.getByTestId("game-screen");
    await expect(screen).toHaveAttribute("data-live", "ready", POLL);
    await page.getByTestId("primary-action").click();
    const squares = page.getByTestId("bingo-square");
    await expect(squares).toHaveCount(25);
    let labels = await squares.evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
    expect(labels[12]).toBe("FREE");
    expect(labels.filter((l) => /^\d+$/.test(l))).toHaveLength(24);
    await expect(host.getByTestId("host-bingo-player")).toHaveCount(1, POLL);

    // Before the host starts the round a player can swap for a new card (own card, marks reset).
    const before = labels.join(",");
    await page.getByTestId("bingo-reroll").click();
    await expect(page.getByTestId("bingo-hint")).toHaveText("You have a new card.", POLL);
    labels = await squares.evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
    expect(labels.join(",")).not.toBe(before);
    expect(labels[12]).toBe("FREE");

    // Round starts; nothing is called yet, so no number is markable.
    await host.getByTestId("start-round").click();
    await expect(screen).toHaveAttribute("data-status", "live", POLL);
    await expect(host.getByTestId("host-draw")).toBeVisible(POLL);
    await expect(page.getByTestId("bingo-reroll")).toHaveCount(0);
    await expect(squares.nth(0)).toHaveAttribute("aria-disabled", "true");

    // Host draws until a number on this card has been called (never more than 75 draws).
    const cardNumbers = new Set(labels.filter((l) => /^\d+$/.test(l)).map(Number));
    let drawn = 0;
    let hit: number | null = null;
    while (hit === null && drawn < 75) {
      await host.getByTestId("host-draw").click();
      drawn += 1;
      await expect(host.getByTestId("host-last-call")).toHaveAttribute("data-value", /\d+/, POLL);
      await expect(host.getByTestId("bingo-called-board")).toHaveAttribute(
        "data-count",
        String(drawn),
        POLL,
      );
      const value = Number(await host.getByTestId("host-last-call").getAttribute("data-value"));
      if (cardNumbers.has(value)) hit = value;
    }
    expect(hit).not.toBeNull();
    await expect(tv.getByTestId("tv-bingo-last-call")).toHaveAttribute(
      "data-value",
      String(hit),
      POLL,
    );
    await expect(tv.getByTestId("bingo-called-board")).toHaveAttribute(
      "data-count",
      String(drawn),
      POLL,
    );
    await expect(page.getByTestId("bingo-last-call")).toHaveAttribute(
      "data-value",
      String(hit),
      POLL,
    );

    // Phone: the called number marks; an uncalled one is inactive and a tap says why.
    const calledIndex = labels.indexOf(String(hit));
    const called = squares.nth(calledIndex);
    await expect(called).toHaveAttribute("data-called", "true");
    await called.click();
    await expect(called).toHaveAttribute("aria-pressed", "true", POLL);
    const uncalledIndex = await squares.evaluateAll((els) =>
      els.findIndex((el) => el.getAttribute("aria-disabled") === "true"),
    );
    expect(uncalledIndex).toBeGreaterThanOrEqual(0);
    const uncalled = squares.nth(uncalledIndex);
    // aria-disabled keeps the button focusable (a tap says why); Playwright counts it as disabled.
    await uncalled.click({ force: true });
    await expect(page.getByTestId("bingo-hint")).toContainText("hasn't been called", POLL);
    await expect(uncalled).toHaveAttribute("aria-pressed", "false");
    await expectNoAxeViolations(page);

    // A false "bingo": the host checks, hears "not yet", and the game goes on.
    const row = host.getByTestId("host-check-row");
    await row.getByTestId("host-check-bingo").click();
    await expect(row.getByTestId("host-check-result")).toContainText("not yet", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "live");

    // Call the card's top row (through the host's own session) and check again: valid, game over.
    const topRow = new Set(
      labels
        .slice(0, 5)
        .filter((l) => /^\d+$/.test(l))
        .map(Number),
    );
    let calledNow = await host
      .getByTestId("called-cell")
      .evaluateAll((els) =>
        els
          .filter((el) => el.getAttribute("data-called") === "true")
          .map((el) => Number(el.getAttribute("data-value"))),
      );
    while (![...topRow].every((v) => calledNow.includes(v)) && drawn < 75) {
      const resp = await apiFromPhone(host, "POST", `/games/${gameId}/bingo/draw`, {
        expected_seq: drawn,
      });
      expect(resp.status).toBe(200);
      const calls = (resp.body as { bingo: { calls: { value: number }[] } }).bingo.calls;
      calledNow = calls.map((c) => c.value);
      drawn = calls.length;
    }
    await expect(host.getByTestId("bingo-called-board")).toHaveAttribute(
      "data-count",
      String(drawn),
      POLL,
    );
    await row.getByTestId("host-check-bingo").click();
    await expect(row.getByTestId("host-check-result")).toContainText("valid", POLL);
    await expect(hostGame).toHaveAttribute("data-status", "ended", POLL);
    await expect(screen).toHaveAttribute("data-status", "ended", POLL);
    await expect(page.getByTestId("bingo-announcement")).toContainText("got bingo", POLL);
    await expect(tv.getByTestId("tv-bingo-winner")).toContainText("got bingo", POLL);
  });
});
