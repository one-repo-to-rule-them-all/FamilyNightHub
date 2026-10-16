import path from "node:path";

import { type BrowserContext, type Page } from "@playwright/test";

import { expect } from "./seed";

/**
 * Photo-drop helpers (ADR-0005), shared by photos.spec.ts and acceptance.spec.ts. Both fixtures
 * carry GPS; gps.heic can't be decoded by Chromium, so it goes through the heic-to worker, as an
 * iPhone's photo would on Chrome or Firefox.
 */
const FIXTURES = path.join(__dirname, "..", "fixtures");
export const JPEG_FIXTURE = path.join(FIXTURES, "gps.jpg");
export const HEIC_FIXTURE = path.join(FIXTURES, "gps.heic");
/** Processing (incl. loading the HEIC decoder) and both PUTs. */
export const UPLOAD_TIMEOUT = 30_000;
/** A presigned bucket URL, wherever it shows up. */
export const PRESIGNED = /X-Amz-Signature=/i;

export type AlbumPhoto = { id: string; person_name: string; url: string; thumb_url: string };

/** /s/[session] on a `tonight` night: the winner, the photo drop and the album. */
export async function openNight(page: Page, sessionId: string) {
  await page.goto(`/s/${sessionId}`);
  await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "tonight");
  await expect(page.getByRole("heading", { name: "Photos from tonight" })).toBeVisible();
}

/** Picks files on the phone's photo input and waits until every upload row is `done`. */
export async function addPhotos(page: Page, files: string[]) {
  await page.getByTestId("photo-input").setInputFiles(files);
  const rows = page.getByTestId("upload-list").getByRole("listitem");
  await expect(rows).toHaveCount(files.length);
  for (const row of await rows.all()) {
    await expect(row).toHaveAttribute("data-state", "done", { timeout: UPLOAD_TIMEOUT });
  }
}

/**
 * Every API answer this context receives, read in full as it passes through, so a test can
 * prove what never reached it (no presigned URL for a phone that hasn't joined).
 */
export async function recordApiAnswers(context: BrowserContext): Promise<string[]> {
  const answers: string[] = [];
  await context.route("**/api/**", async (route) => {
    const response = await route.fetch();
    answers.push(`${route.request().url()} ${await response.text()}`);
    await route.fulfill({ response });
  });
  return answers;
}
