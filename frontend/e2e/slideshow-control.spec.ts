import { type Browser, type Page } from "@playwright/test";

import { expectNoAxeViolations, signInAsHost } from "./support/host";
import { joinAs, newPhone } from "./support/phones";
import { addPhotos, JPEG_FIXTURE, openNight } from "./support/photos";
import { expect, type SeededNight, seedNight, test } from "./support/seed";

/**
 * The slideshow follow-ups (issue #41, 04-frontend.md "TV slideshow"): the host's Start/Stop
 * drives a paired TV live (status_changed, no reload), and a phone's "Play slideshow" plays the
 * album full screen with new photos arriving live. Nothing here sleeps: every wait is on the DOM.
 */

/** A live hint reaches a screen through the stream; the margin covers a cold runner. */
const LIVE = { timeout: 10_000 };

async function pairedTv(browser: Browser, night: SeededNight, origin: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 720 },
  });
  await signInAsHost(context, night, origin);
  const tv = await context.newPage();
  await tv.goto("/host");
  await tv.getByRole("button", { name: "Use this browser as the TV" }).click();
  await tv.getByRole("button", { name: "Yes, make it the TV" }).click();
  await expect(tv).toHaveURL(new RegExp(`/tv/${night.sessionId}$`));
  await expect(tv.locator("[data-live]").first()).toHaveAttribute("data-live", "ready");
  return tv;
}

async function hostPhone(browser: Browser, night: SeededNight, origin: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  await signInAsHost(context, night, origin);
  const host = await context.newPage();
  await host.goto(`/host/${night.sessionId}`);
  await expect(host.locator("[data-live]").first()).toHaveAttribute("data-live", "ready");
  return host;
}

test.describe("Slideshow control", () => {
  test("the host's Start and Stop switch a paired TV without a reload", async ({
    browser,
    baseURL,
    page,
  }) => {
    test.setTimeout(120_000);
    const night = seedNight({ movies: 2, tonight: true });
    await joinAs(page, night, ["Ava"]);
    await openNight(page, night.sessionId);
    await addPhotos(page, [JPEG_FIXTURE]);

    const tv = await pairedTv(browser, night, baseURL as string);
    // A marker that only survives if the TV never reloads.
    await tv.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    // Never pressed: auto, the TV plays what the album has.
    await expect(tv.getByTestId("tv-slideshow")).toBeVisible(LIVE);

    const host = await hostPhone(browser, night, baseURL as string);
    const control = host.getByTestId("slideshow-control");
    await expect(control).toHaveAttribute("data-mode", "auto");
    await expectNoAxeViolations(host);

    // Stop: the TV holds on the drop prompt.
    await host.getByRole("button", { name: "Start slideshow on the TV" }).click();
    await expect(control).toHaveAttribute("data-mode", "playing");
    await host.getByRole("button", { name: "Stop the slideshow" }).click();
    await expect(control).toHaveAttribute("data-mode", "stopped");
    await expect(host.getByTestId("slideshow-status")).toHaveText(/holding/);
    await expect(tv.getByTestId("tv-photo-idle")).toHaveAttribute("data-held", "true", LIVE);
    await expect(tv.getByTestId("tv-slideshow")).toHaveCount(0);
    await expectNoAxeViolations(tv);

    // Start: the TV switches back into the slideshow, live.
    await host.getByRole("button", { name: "Start slideshow on the TV" }).click();
    await expect(control).toHaveAttribute("data-mode", "playing");
    await expect(tv.getByTestId("tv-slideshow")).toBeVisible(LIVE);
    await expect(tv.getByRole("img", { name: /^Photo from Ava, / })).toBeVisible();
    expect(
      await tv.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);
    await expectNoAxeViolations(host);

    await host.context().close();
    await tv.context().close();
  });

  test("a guest phone plays the album and sees another phone's upload arrive", async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const night = seedNight({ movies: 2, tonight: true });
    await joinAs(page, night, ["Ava"]);
    await openNight(page, night.sessionId);
    await addPhotos(page, [JPEG_FIXTURE]);

    // A guest: joined with the night code, holds nobody.
    const guest = await newPhone(browser);
    await joinAs(guest, night, []);
    await guest.goto(`/albums/${night.sessionId}`);
    await expect(guest.locator("[data-live]").first()).toHaveAttribute("data-live", "ready");
    await guest.getByRole("button", { name: "Play slideshow" }).click();

    const show = guest.getByTestId("phone-slideshow");
    await expect(show).toBeVisible();
    await expect(show.getByRole("img", { name: /^Photo from Ava, / })).toBeVisible();
    await expect(guest.getByTestId("phone-slideshow-count")).toHaveText("1 photo");
    await expectNoAxeViolations(guest);

    // Ava's phone adds another: it reaches the guest's slideshow live and jumps the queue.
    const first = await show.getAttribute("data-photo");
    await addPhotos(page, [JPEG_FIXTURE]);
    await expect(guest.getByTestId("phone-slideshow-count")).toHaveText("2 photos", LIVE);
    await expect(show).not.toHaveAttribute("data-photo", first!, { timeout: 12_000 });

    // Tap pauses, a swipe steps, tap resumes.
    const stage = guest.getByTestId("phone-slideshow-stage");
    await stage.click();
    await expect(show).toHaveAttribute("data-paused", "true");
    const onScreen = await show.getAttribute("data-photo");
    await stage.dispatchEvent("pointerdown", { clientX: 300, clientY: 400 });
    await stage.dispatchEvent("pointerup", { clientX: 100, clientY: 410 });
    await expect(show).not.toHaveAttribute("data-photo", onScreen!);
    await expect(show).toHaveAttribute("data-paused", "true");
    await stage.click();
    await expect(show).toHaveAttribute("data-paused", "false");

    await guest.getByRole("button", { name: "Close slideshow" }).click();
    await expect(show).toHaveCount(0);
    await guest.context().close();
  });
});
