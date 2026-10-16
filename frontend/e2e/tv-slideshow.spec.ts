import { type Browser, type Page } from "@playwright/test";

import { expectNoAxeViolations, signInAsHost } from "./support/host";
import { apiFromPhone, joinAs, newPhone } from "./support/phones";
import { addPhotos, type AlbumPhoto, JPEG_FIXTURE, openNight, PRESIGNED } from "./support/photos";
import { expect, type SeededNight, seedNight, test } from "./support/seed";

/**
 * The TV photo slideshow (04-frontend.md "TV", ADR-0005) against the real API and a real bucket
 * (SeaweedFS): a paired TV on a `tonight` night waits on "Drop your photos", then plays what a
 * phone uploads with no reload (the stream's photo_added), lets the remote step and pause, drops
 * a photo the host hides, and holds still under prefers-reduced-motion.
 */

/** photo_added reaches the TV through the stream; the margin covers processing on a cold runner. */
const LIVE = { timeout: 10_000 };
/** Hiding publishes no event: the TV's album sweep (10s) drops it, plus a margin. */
const SWEEP = { timeout: 20_000 };

/** The host signs in on the TV's browser (1280x720) and pairs it; /tv follows the seeded night. */
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

/** The photo on screen: the only <img> with alt text (the preloaded/outgoing ones are hidden). */
const onScreen = (tv: Page) => tv.getByRole("img", { name: /^Photo from / });

const animationName = (tv: Page) =>
  tv.locator('[data-role="current"]').evaluate((img) => getComputedStyle(img).animationName);

test.describe("TV slideshow", () => {
  test("plays phone uploads live, steps and pauses by remote, drops a hidden photo", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const night = seedNight({ movies: 2, tonight: true });
    const tv = await pairedTv(browser, night, baseURL as string);
    const consoleLines: string[] = [];
    tv.on("console", (message) => consoleLines.push(message.text()));

    // Nothing in the album yet: the TV asks for photos.
    const idle = tv.getByTestId("tv-photo-idle");
    await expect(
      idle.getByRole("heading", { name: "Drop your photos from your phone" }),
    ).toBeVisible();
    await expect(tv.getByTestId("tv-slideshow")).toHaveCount(0);
    await expectNoAxeViolations(tv);

    // A phone adds a photo: the TV shows it without a reload.
    const phone = await newPhone(browser);
    await joinAs(phone, night, ["Ava"]);
    await openNight(phone, night.sessionId);
    await addPhotos(phone, [JPEG_FIXTURE]);

    const slideshow = tv.getByTestId("tv-slideshow");
    await expect(slideshow).toBeVisible(LIVE);
    await expect(onScreen(tv)).toHaveAccessibleName(/^Photo from Ava, \w+ \d{1,2}, \d{4}$/);
    await expect(onScreen(tv)).toHaveJSProperty("complete", true);
    expect(
      await onScreen(tv).evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBeGreaterThan(0);
    await expect(tv.getByTestId("tv-caption-name")).toHaveText("Ava");
    await expect(tv.getByTestId("tv-photo-count")).toHaveText("1 photo");
    // The slow pan runs when motion is welcome.
    expect(await animationName(tv)).toMatch(/^tv-pan-/);
    await expectNoAxeViolations(tv);

    // Leo's phone adds one: it jumps the queue and goes on screen next.
    const first = await slideshow.getAttribute("data-photo");
    const leo = await newPhone(browser);
    await joinAs(leo, night, ["Leo"]);
    await openNight(leo, night.sessionId);
    await addPhotos(leo, [JPEG_FIXTURE]);
    await expect(tv.getByTestId("tv-photo-count")).toHaveText("2 photos", LIVE);
    const album = (await apiFromPhone(tv, "GET", `/sessions/${night.sessionId}/photos`))
      .body as AlbumPhoto[];
    const newest = album[0].id;
    expect(newest).not.toBe(first);
    await expect(slideshow).toHaveAttribute("data-photo", newest, { timeout: 12_000 });
    await expect(onScreen(tv)).toHaveAccessibleName(/^Photo from Leo, /);
    await expect(tv.getByTestId("tv-caption-name")).toHaveText("Leo");

    // The remote: space pauses (and says so), arrows step, space resumes.
    await tv.keyboard.press("Space");
    await expect(tv.getByTestId("tv-paused")).toHaveText("Paused");
    await expect(slideshow).toHaveAttribute("data-paused", "true");
    await expectNoAxeViolations(tv);
    await tv.keyboard.press("ArrowRight");
    await expect(slideshow).toHaveAttribute("data-photo", first!);
    await tv.keyboard.press("ArrowLeft");
    await expect(slideshow).toHaveAttribute("data-photo", newest);
    await expect(slideshow).toHaveAttribute("data-paused", "true");
    await tv.keyboard.press("Space");
    await expect(tv.getByTestId("tv-paused")).toHaveCount(0);

    // The host hides Leo's photo from their phone: the TV drops it on its next album refresh.
    await tv.keyboard.press("Space");
    const hostContext = await browser.newContext({ baseURL });
    await signInAsHost(hostContext, night, baseURL as string);
    const host = await hostContext.newPage();
    await host.goto("/host");
    const hidden = await apiFromPhone(
      host,
      "POST",
      `/sessions/${night.sessionId}/photos/${newest}/hide`,
    );
    expect(hidden.status).toBe(204);
    await expect(tv.getByTestId("tv-photo-count")).toHaveText("1 photo", SWEEP);
    await expect(slideshow).toHaveAttribute("data-photo", first!);
    await tv.keyboard.press("ArrowRight");
    await expect(slideshow).toHaveAttribute("data-photo", first!);

    // Presigned URLs live only in <img src>: nowhere else in the DOM, never in the console.
    const htmlWithoutSrc = await tv.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("img").forEach((img) => img.removeAttribute("src"));
      return clone.outerHTML;
    });
    expect(htmlWithoutSrc).not.toMatch(PRESIGNED);
    expect(consoleLines.filter((line) => PRESIGNED.test(line))).toEqual([]);

    await hostContext.close();
    await phone.context().close();
    await leo.context().close();
    await tv.context().close();
  });

  test("reduced motion: no pan and no crossfade", async ({ browser, baseURL, page }) => {
    const night = seedNight({ movies: 2, tonight: true });
    await joinAs(page, night, ["Mia"]);
    await openNight(page, night.sessionId);
    await addPhotos(page, [JPEG_FIXTURE]);

    const tv = await pairedTv(browser, night, baseURL as string);
    await tv.emulateMedia({ reducedMotion: "reduce" });
    await expect(onScreen(tv)).toHaveAccessibleName(/^Photo from Mia, /);
    await expect(onScreen(tv)).toHaveJSProperty("complete", true);
    expect(await animationName(tv)).toBe("none");
    await expectNoAxeViolations(tv);

    await tv.emulateMedia({ reducedMotion: "no-preference" });
    expect(await animationName(tv)).toMatch(/^tv-pan-/);
    await tv.context().close();
  });
});
