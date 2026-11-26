import { expectNoAxeViolations, pairAsTv, signInAsHost } from "./support/host";
import { expect, seedNight, test } from "./support/seed";

/** Generous: the reel's snapshot loads once and the slides then cycle on a 12 s dwell. */
const CYCLE = { timeout: 60_000 };

/**
 * The night reel (ADR-0018 amendment "Night reel"): /tv/reel cycles the household's quotes and
 * winners by itself, in the server's order, with no clicking. The seed has a finished jar (a named
 * and an anonymous note) and a classic bingo round Ava won, so the reel has three slides.
 */
test.describe("night reel", () => {
  test("cycles quotes and a winner by itself and never names an anonymous author", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2, reel: true });

    // The host's Games area offers the reel.
    const hostContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(hostContext, night, origin);
    const hub = await hostContext.newPage();
    await hub.goto("/host/games");
    await expect(hub.getByTestId("night-reel-card")).toBeVisible();
    await expect(hub.getByTestId("open-reel")).toHaveAttribute("href", "/tv/reel");

    // The TV: paired, opened on the reel.
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await tv.goto("/tv/reel");
    const reel = tv.getByTestId("tv-reel");
    await expect(reel).toHaveAttribute("data-live", "ready", CYCLE);
    await expect(reel).toHaveAttribute("data-count", "3");
    await expect(tv.getByTestId("reel-progress")).toContainText("of 3");

    // Over the dwell cycle every slide comes round without a click: gather what the stage says.
    const stages = new Set<string>();
    await expect
      .poll(
        async () => {
          stages.add(await tv.getByTestId("reel-stage").innerText());
          return stages.size;
        },
        { ...CYCLE, intervals: [1_000] },
      )
      .toBe(3);
    const all = [...stages].join(" | ");
    expect(all).toContain("Ava got BINGO!");
    expect(all).toContain("Reel quote from Ava");
    // The anonymous note shows its words and no name.
    const anonymous = [...stages].find((t) => t.includes("Reel quote kept anonymous")) ?? "";
    expect(anonymous).toContain("Someone in the family");
    expect(anonymous).not.toContain("Ava");
    await expectNoAxeViolations(tv);
  });
  test("an ended jar's own TV view keeps cycling its notes", async ({ browser, baseURL }) => {
    test.slow();
    const origin = baseURL as string;
    const night = seedNight({ movies: 2, reel: true });
    const tvContext = await browser.newContext({ baseURL: origin });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    const games = (await (await tvContext.request.get(`${origin}/api/v1/games`)).json()) as {
      id: string;
      kind: string;
    }[];
    const jar = games.find((g) => g.kind === "gratitude_jar");
    await tv.goto(`/tv/games/${jar?.id}`);
    await expect(tv.getByTestId("tv-jar")).toHaveAttribute("data-status", "ended", CYCLE);
    // Not just the thank-you line: the two notes take turns, by themselves.
    const notes = new Set<string>();
    await expect
      .poll(
        async () => {
          if (await tv.getByTestId("tv-note").count()) {
            notes.add(await tv.getByTestId("tv-note").innerText());
          }
          return notes.size;
        },
        { ...CYCLE, intervals: [1_000] },
      )
      .toBe(2);
    await expect(tv.getByTestId("tv-jar-ended")).toBeVisible();
  });
});
