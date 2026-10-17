import { devices } from "@playwright/test";

import {
  castPhoneBallot,
  expectNoAxeViolations,
  pinTieBreakSeed,
  signInAsHost,
} from "./support/host";
import { expect, test } from "./support/seed";

/** The tie-break seed the host's close pins (honoured only with ENVIRONMENT=test, 07-cicd.md). */
const TEST_SEED = "424242";
/** Generous: updates arrive live (SSE), and a dropped stream falls back to the 5s poll. */
const POLL = { timeout: 15_000 };

test.describe("host and TV", () => {
  test("a night end to end: pair the TV, shortlist, phone + proxy votes, close, reveal", async ({
    browser,
    page,
    night,
    baseURL,
  }) => {
    test.slow(); // three browsers and a few poll cycles
    const origin = baseURL as string;

    // --- The TV's browser: the host signs in there, starts the night, pairs it as the TV.
    const tvContext = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 720 },
    });
    await signInAsHost(tvContext, night, origin);
    const tv = await tvContext.newPage();
    await tv.goto("/host");
    await expect(tv.getByTestId("signed-in-as")).toContainText(night.householdName);
    await tv.getByLabel("Name it (optional)").fill("E2E Friday");
    await tv.getByRole("button", { name: "Start a night" }).click();

    const codeText = tv.getByTestId("night-code");
    await expect(codeText).toHaveText(/^[2-9A-HJKMNP-Z]{6}$/);
    const code = (await codeText.textContent())!.trim();

    await tv.getByRole("button", { name: "Use this browser as the TV" }).click();
    await tv.getByRole("button", { name: "Yes, make it the TV" }).click();
    await expect(tv).toHaveURL(/\/tv\/[0-9a-f-]{36}$/);
    const sessionId = tv.url().split("/").at(-1)!;

    // The code reached the TV in this tab only; the server never gives it back.
    await expect(tv.getByTestId("tv-night-code")).toHaveText(code);
    await expect(tv.locator("[data-live]").first()).toHaveAttribute("data-live", "ready");
    await expect(tv.getByTestId("tv-tile")).toHaveCount(night.people.length);
    await expectNoAxeViolations(tv);
    // Pairing signed the host out of the TV's browser (ADR-0002).
    expect((await tvContext.cookies()).map((c) => c.name)).not.toContain("fnh_session");

    // --- The host's phone: build the shortlist.
    await signInAsHost(page.context(), night, origin);
    await page.goto("/host");
    await page.getByRole("link", { name: /E2E Friday/ }).click();
    await expect(page).toHaveURL(new RegExp(`/host/${sessionId}$`));
    await expect(page.getByTestId("night-status")).toHaveText("Building the shortlist");
    // Another browser: it never saw the code, so it offers a rotate instead of showing one.
    await expect(page.getByTestId("night-code-hidden")).toBeVisible();

    // TMDB down (CI runs without it; forced here so the test is the same everywhere).
    await page.route("**/api/v1/tmdb/search**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "service_unavailable", message: "TMDB is unavailable", request_id: "e2e" },
        }),
      }),
    );
    await page.getByLabel("Search posters").fill("Paddington");
    await expect(page.getByTestId("tmdb-unavailable")).toBeVisible();
    await expect(page.getByTestId("tmdb-attribution")).toContainText("TMDB");

    const openVoting = page.getByRole("button", { name: "Open voting" });
    for (const [title, year] of [
      ["Paddington", "2014"],
      ["Up", "2009"],
      ["Moana", ""],
    ]) {
      await page.getByLabel("Movie title").fill(title);
      await page.getByLabel("Year (optional)").fill(year);
      await page.getByRole("button", { name: "Add title" }).click();
      await expect(page.getByTestId("shortlist-item").filter({ hasText: title })).toBeVisible();
      if (title === "Paddington") await expect(openVoting).toBeDisabled(); // needs 2
    }
    await expect(page.getByTestId("shortlist-count")).toHaveText("3 of 8");

    await page.getByRole("button", { name: "Move Moana up" }).click();
    await expect(page.getByTestId("shortlist-item")).toHaveText([/Paddington/, /Moana/, /Up/]);
    await page.getByRole("button", { name: "Remove Up" }).click();
    await expect(page.getByTestId("shortlist-item")).toHaveText([/Paddington/, /Moana/]);
    // Server-derived: the order survives a reload.
    await page.reload();
    await expect(page.getByTestId("shortlist-item")).toHaveText([/Paddington/, /Moana/], POLL);
    await expectNoAxeViolations(page);

    await openVoting.click();
    await expect(page.getByTestId("night-status")).toHaveText("Voting");
    await expect(tv.getByTestId("tv-headline")).toHaveText(
      `0 of ${night.people.length} voted`,
      POLL,
    );

    // --- A phone joins with the code on the TV and votes.
    const phoneContext = await browser.newContext({ ...devices["Pixel 7"], baseURL: origin });
    const phone = await phoneContext.newPage();
    await phone.goto(`/j/${night.slug}`);
    await phone.getByLabel("Night code").fill(code);
    await phone.getByRole("button", { name: "Join" }).click();
    await expect(phone).toHaveURL(/\/who$/);
    await phone.getByRole("button", { name: /^Ava/ }).click();
    await expect(phone.getByRole("button", { name: /^Ava/ })).toHaveAttribute(
      "data-binding",
      "mine",
    );
    expect(await castPhoneBallot(phone, sessionId, "Ava", ["Paddington"])).toBe(204);

    const avaTile = tv.getByTestId("tv-tile").and(tv.locator('[data-person="Ava"]'));
    await expect(avaTile).toHaveAttribute("data-voted", "true", POLL);
    await expect(page.getByTestId("voted-count")).toHaveText("1 so far", POLL);

    // --- Proxy vote for Mia (no phone). Listing people needs this browser to be a device too.
    await page.getByRole("button", { name: "Add this browser to the family" }).click();
    await page.getByRole("button", { name: "Mia" }).click();
    await page.getByRole("button", { name: "Paddington" }).click();
    await expect(page.getByRole("button", { name: "Paddington, rank 1" })).toBeVisible();
    await page.getByRole("button", { name: "Save Mia's vote" }).click();
    await expect(page.getByTestId("proxy-saved")).toHaveText("Saved Mia's vote.");
    // The API commits the ballot after answering, so the immediate refetch can still say 1: the
    // next poll catches up.
    await expect(page.getByTestId("voted-count")).toHaveText("2 so far", POLL);
    const miaTile = tv.getByTestId("tv-tile").and(tv.locator('[data-person="Mia"]'));
    await expect(miaTile).toHaveAttribute("data-voted", "true", POLL);
    await expect(tv.getByTestId("tv-headline")).toHaveText(`2 of ${night.people.length} voted`);
    await expectNoAxeViolations(tv);

    // --- Close with a pinned tie-break seed; the TV spins and lands on the stored winner.
    await pinTieBreakSeed(page, TEST_SEED);
    await page.getByRole("button", { name: "Close voting" }).click();
    await expect(page.getByTestId("winner-title")).toHaveText("Paddington");

    await expect(tv.getByTestId("tv-winner")).toBeVisible({ timeout: 25_000 });
    await expect(tv.getByRole("heading", { name: "Paddington" })).toBeVisible();
    await expectNoAxeViolations(tv);

    await phoneContext.close();
    await tvContext.close();
  });

  test("a paired TV that never saw the code asks for it once", async ({
    browser,
    night,
    baseURL,
  }) => {
    const origin = baseURL as string;
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 720 },
      reducedMotion: "reduce",
    });
    await signInAsHost(context, night, origin);
    const tv = await context.newPage();
    await tv.goto("/host");
    // Pair without starting a night here: /tv follows the seeded night, whose code it never saw.
    await tv.getByRole("button", { name: "Use this browser as the TV" }).click();
    await tv.getByRole("button", { name: "Yes, make it the TV" }).click();
    await expect(tv).toHaveURL(/\/tv\/[0-9a-f-]{36}$/);

    await expect(tv.getByTestId("tv-night-code")).toHaveCount(0);
    await tv
      .getByLabel("Host: type tonight's code to show it here")
      .fill(night.nightCode.toLowerCase());
    await tv.getByRole("button", { name: "Show code" }).click();
    await expect(tv.getByTestId("tv-night-code")).toHaveText(night.nightCode);
    await tv.reload();
    await expect(tv.getByTestId("tv-night-code")).toHaveText(night.nightCode);
    await context.close();
  });

  test("/tv on an unpaired browser explains pairing", async ({ page }) => {
    await page.goto("/tv");
    await expect(page.getByTestId("tv-unpaired")).toBeVisible();
    await expect(page.getByRole("link", { name: "Host sign-in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});
