import { type APIRequestContext } from "@playwright/test";
import exifr from "exifr";

import { apiFromPhone, expectNoAxeViolations, joinAs, newPhone } from "./support/phones";
import {
  addPhotos,
  type AlbumPhoto,
  HEIC_FIXTURE,
  JPEG_FIXTURE,
  openNight,
  PRESIGNED,
  recordApiAnswers,
} from "./support/photos";
import { expect, seedNight, test } from "./support/seed";

/**
 * The photo drop (ADR-0005) against the real API and a real S3 bucket (SeaweedFS): phones process
 * photos in the browser, PUT them straight to the bucket, and view them through presigned GETs.
 * gps.heic can't be decoded by Chromium, so it goes through the heic-to worker, as an iPhone's
 * photo would on Chrome or Firefox. Both fixtures carry GPS; what lands in the bucket must not.
 */

/** The stored bytes, fetched through the presigned URL the album handed out. */
async function storedBytes(request: APIRequestContext, url: string): Promise<Buffer> {
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/jpeg");
  return response.body();
}

test.describe("photo drop", () => {
  test("photos added on one phone show up on another, without GPS, and get reactions", async ({
    page,
    browser,
    request,
  }) => {
    test.slow(); // two phones with PINs (argon2id), two photo pipelines incl. HEIC decoding
    const night = seedNight({ movies: 2, tonight: true });

    await joinAs(page, night, ["Ava"]);
    await openNight(page, night.sessionId);
    await expect(page.getByTestId("album-empty")).toBeVisible();
    // A plain picker: library and camera both, and never an image/heic filter.
    const input = page.getByTestId("photo-input");
    await expect(input).toHaveAttribute("accept", "image/*");
    await expect(input).toHaveAttribute("multiple", "");
    await expect(input).not.toHaveAttribute("capture");
    await expectNoAxeViolations(page);

    await addPhotos(page, [JPEG_FIXTURE, HEIC_FIXTURE]);
    await expect(page.getByTestId("album-grid").getByRole("listitem")).toHaveCount(2);
    await expectNoAxeViolations(page);

    // What the bucket holds: JPEGs at most 2048px, with no GPS and no EXIF at all.
    const album = (await apiFromPhone(page, "GET", `/sessions/${night.sessionId}/photos`))
      .body as AlbumPhoto[];
    expect(album).toHaveLength(2);
    for (const photo of album) {
      expect(photo.person_name).toBe("Ava");
      for (const url of [photo.url, photo.thumb_url]) {
        const bytes = await storedBytes(request, url);
        expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(await exifr.gps(bytes)).toBeUndefined();
        expect(await exifr.parse(bytes, { gps: true, tiff: true, exif: true })).toBeUndefined();
      }
    }

    // Phone B (Leo) sees both on the album page and reacts.
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    await phoneB.goto(`/albums/${night.sessionId}`);
    const grid = phoneB.getByTestId("album-grid").getByRole("listitem");
    await expect(grid).toHaveCount(2);
    await expectNoAxeViolations(phoneB);

    await phoneB.getByRole("button", { name: "Open photo by Ava" }).first().click();
    const viewer = phoneB.getByTestId("photo-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("viewer-by")).toHaveText("Ava");
    await expect(viewer.getByRole("img", { name: "Photo by Ava" })).toHaveJSProperty(
      "complete",
      true,
    );
    const heart = viewer.getByTestId("react-❤️");
    await expect(heart).toHaveAttribute("aria-pressed", "false");
    await heart.click();
    await expect(heart).toHaveAttribute("aria-pressed", "true");
    await expect(heart).toHaveAccessibleName("React ❤️, 1");
    await expectNoAxeViolations(phoneB);
    await viewer.getByRole("button", { name: "Next photo" }).click();
    await expect(viewer.getByText("Photo 2 of 2")).toBeVisible();
    await viewer.getByRole("button", { name: "Close" }).click();
    await expect(viewer).toHaveCount(0);

    // Phone A sees Leo's heart (not as its own) once it reloads the album.
    await page.reload();
    await page.getByRole("button", { name: "Open photo by Ava" }).first().click();
    const heartOnA = page.getByTestId("photo-viewer").getByTestId("react-❤️");
    await expect(heartOnA).toHaveAccessibleName("React ❤️, 1");
    await expect(heartOnA).toHaveAttribute("aria-pressed", "false");

    await phoneB.context().close();
  });

  test("a phone that hasn't joined gets no photo URLs at all", async ({ page, browser }) => {
    const night = seedNight({ movies: 2, tonight: true });
    await joinAs(page, night, ["Mia"]);
    await openNight(page, night.sessionId);
    // The first PUT to the bucket drops: the queue backs off and the photo still lands.
    let dropped = 0;
    await page.route(
      (url) => PRESIGNED.test(url.search),
      (route) => {
        if (route.request().method() === "PUT" && dropped === 0) {
          dropped += 1;
          return route.abort("connectionreset");
        }
        return route.continue();
      },
    );
    await addPhotos(page, [JPEG_FIXTURE]);
    expect(dropped).toBe(1);

    // A fresh context: no device cookie, no account session.
    const strangerPage = await newPhone(browser);
    // Every API answer this phone gets, read in full as it passes through.
    const answers = await recordApiAnswers(strangerPage.context());

    await strangerPage.goto(`/albums/${night.sessionId}`);
    await expect(
      strangerPage.getByText("Join a movie night on this phone to see your family's photos."),
    ).toBeVisible();
    const direct = await strangerPage.evaluate(async (sessionId) => {
      const response = await fetch(`/api/v1/sessions/${sessionId}/photos`);
      return { status: response.status, body: await response.text() };
    }, night.sessionId);
    expect(direct.status).toBe(401);
    expect(direct.body).not.toMatch(PRESIGNED);

    await strangerPage.goto(`/s/${night.sessionId}`);
    // No device: the resolver's landing (S0), never the night.
    await expect(strangerPage.locator('[data-screen="landing"]')).toBeVisible();
    await expect(strangerPage.locator("img")).toHaveCount(0);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(answer).not.toMatch(PRESIGNED);

    await strangerPage.context().close();
  });
});
