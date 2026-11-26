import { pairAsTv, signInAsHost } from "./support/host";
import { expect, seedNight, test } from "./support/seed";

/** Generous: the TV follows the host by polling the target every few seconds. */
const POLL = { timeout: 20_000 };

/**
 * The paired TV follows the host (ADR-0018 amendment "The TV follows the host"): a game made
 * from the owner panel opens in its own tab and leaves the hub tab alone; "Show on TV" moves the
 * paired /tv screen onto the game, "Back to QR" returns it to the night's QR screen.
 */
test.describe("games on the paired TV", () => {
  test("Show on TV moves the TV to the game and Back to QR returns it", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2 });

    // Host: the hub stays on /host/games; the control page opens in a second tab.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await hub.getByTestId("game-title").fill("TV jar");
    const [host] = await Promise.all([
      hub.waitForEvent("popup"),
      hub.getByTestId("create-game").click(),
    ]);
    await expect(hub).toHaveURL(/\/host\/games$/);
    await expect(host).toHaveURL(/\/host\/games\/[0-9a-f-]{36}$/);
    const gameId = host.url().split("/").pop()!;
    await expect(host.getByTestId("host-game")).toHaveAttribute("data-live", "ready", POLL);

    // TV: paired, resting on the night's screen (the QR) rather than the game.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    // A controllable clock: the finished game holds the TV for two minutes (TV_HOLD_MS).
    await tv.clock.install();
    await pairAsTv(tv);
    await tv.goto("/tv");
    await expect(tv).toHaveURL(new RegExp(`/tv/${night.sessionId}$`), POLL);

    // Show on TV: the same TV tab moves onto the game.
    await expect(host.getByTestId("show-on-tv")).toHaveText(/Show on TV/);
    await host.getByTestId("show-on-tv").click();
    await expect(host.getByTestId("show-on-tv")).toHaveText(/Back to QR/, POLL);
    await expect(tv).toHaveURL(new RegExp(`/tv/games/${gameId}$`), POLL);
    await expect(tv.getByTestId("tv-jar")).toHaveAttribute("data-live", "ready", POLL);

    // Back to QR: the TV returns to the night's screen.
    await host.getByTestId("show-on-tv").click();
    await expect(host.getByTestId("show-on-tv")).toHaveText(/Show on TV/, POLL);
    await expect(tv).toHaveURL(new RegExp(`/tv/${night.sessionId}$`), POLL);

    // Show again, then end the game: the TV holds the finished game's screen for two minutes,
    // then leaves it on its own (win and lose moment, ADR-0018 amendment 2026-11-26).
    await host.getByTestId("show-on-tv").click();
    await expect(tv).toHaveURL(new RegExp(`/tv/games/${gameId}$`), POLL);
    await host.getByTestId("end-game").click();
    await expect(tv.getByTestId("tv-jar")).toHaveAttribute("data-status", "ended", POLL);
    const polled = tv.waitForResponse((r) => r.url().includes("/games/tv-target"));
    await tv.clock.fastForward("01:00");
    await polled;
    // A minute in, several polls later, the TV is still on the finished game.
    await expect(tv.getByTestId("tv-jar")).toHaveAttribute("data-status", "ended");
    await expect(tv).toHaveURL(new RegExp(`/tv/games/${gameId}$`));
    await tv.clock.fastForward("02:10");
    await expect(tv).toHaveURL(new RegExp(`/tv/${night.sessionId}$`), POLL);
  });
});
