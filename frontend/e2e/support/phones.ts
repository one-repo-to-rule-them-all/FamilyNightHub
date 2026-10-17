import AxeBuilder from "@axe-core/playwright";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  devices,
  type Page,
  test,
} from "@playwright/test";

import { expect, type SeededNight } from "./seed";

/** WCAG 2.1 AA, as in Ctrl+Alt+Defeat's axe checks. */
export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** Another phone: a fresh context (own cookies) with the current project's device profile. */
export async function newPhone(browser: Browser): Promise<Page> {
  const use = test.info().project.use;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
  });
  return context.newPage();
}

/**
 * A phone with an explicit device profile (Chromium either way: the API's cookies are Secure),
 * for specs that mix iPhones and Pixels in one run.
 */
export async function newPhoneLike(
  browser: Browser,
  device: "iPhone 13" | "Pixel 7",
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...devices[device], baseURL });
  return { context, page: await context.newPage() };
}

/**
 * Each seeded person's test PIN (ADR-0014: every person has a 6-digit PIN). Stable per name, so a
 * second phone claiming the same person types the same PIN.
 */
export const PINS: Record<string, string> = {
  Ava: "135790",
  Leo: "246813",
  Mia: "975310",
  // admin.spec merges Nana into Grandma: one PIN, whichever of the two ends up holding it.
  Nana: "864209",
  Grandma: "864209",
};
export const pinFor = (name: string) => PINS[name] ?? "112358";

/** Types a PIN on the open PIN sheet's keypad input (the hidden numeric input the keypad drives). */
export async function typePin(page: Page, pin: string) {
  await page.getByTestId("pin-input").fill(pin);
}

/**
 * Taps `name` on /who and gets through the PIN sheet: a first claim chooses the PIN (S3c, typed
 * twice), a later one types it (S3e). Ends once the phone has left /who for the night.
 */
export async function pickPerson(page: Page, name: string, pin = pinFor(name)) {
  await expect(page).toHaveURL(/\/who$/);
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const sheet = page.getByTestId("pin-sheet");
  await expect(sheet).toBeVisible();
  if ((await sheet.locator("[data-screen]").first().getAttribute("data-screen")) === "pin-create") {
    await typePin(page, pin);
    await expect(sheet).toContainText("Type it again");
  }
  await typePin(page, pin);
  await expect(page).not.toHaveURL(/\/who$/);
}

/** Types the night code on /j/{slug}; the form joins by itself once the code is complete. */
export async function joinNight(page: Page, night: Pick<SeededNight, "slug" | "nightCode">) {
  await page.goto(`/j/${night.slug}`);
  await page.getByLabel("Night code").fill(night.nightCode);
  await expect(page).toHaveURL(/\/who$/);
}

/**
 * Join with the night code, then claim each person through /who with their PIN. The last name is
 * the phone's current person (ADR-0014: one current person per phone).
 */
export async function joinAs(
  page: Page,
  night: Pick<SeededNight, "slug" | "nightCode">,
  names: string[],
) {
  await joinNight(page, night);
  for (const [i, name] of names.entries()) {
    if (i > 0) await page.goto("/who");
    await pickPerson(page, name);
  }
}

/**
 * The shared-phone switch (guest-flow "Switch sheet"): the chip's Switch (or S11's "Pass to next
 * person") → their tile → their PIN. ADR-0014: every switch needs that person's PIN.
 */
export async function switchTo(
  page: Page,
  name: string,
  { pin = pinFor(name), via = "chip" }: { pin?: string; via?: "chip" | "pass" } = {},
) {
  if (via === "chip") await page.getByTestId("current-chip").click();
  else await page.getByRole("button", { name: "Pass to next person" }).click();
  const sheet = page.getByTestId("switch-sheet");
  await sheet.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByTestId("pin-sheet")).toBeVisible();
  await typePin(page, pin);
  await expect(page.getByTestId("pin-sheet")).toHaveCount(0);
  await expect(page.getByTestId("voting-as").first()).toHaveText(name);
}

/**
 * A call from inside the phone's page, so it carries that phone's cookies and the CSRF
 * double-submit token exactly as the app does. For asserting what the server refuses.
 */
export async function apiFromPhone(
  page: Page,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = (await (await fetch("/api/v1/csrf", { credentials: "include" })).json()) as {
        csrf_token: string;
      };
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-FNH-CSRF": csrf.csrf_token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        // 204
      }
      return { status: response.status, body: json };
    },
    { method, path, body },
  );
}

/** A poster on the phone ballot, ranked or not. */
export const poster = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^(Pick \\d )?${title}`) });

/** Tap posters in order, then Done; the confirmation lists what the server saved. */
export async function vote(page: Page, name: string, titles: readonly string[]) {
  await expect(page.getByTestId("voting-as")).toHaveText(name);
  for (const title of titles) await poster(page, title).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: `Thanks, ${name}!` })).toBeVisible();
  const saved = page.getByTestId("saved-picks").getByRole("listitem");
  await expect(saved).toHaveText(titles.map((title, i) => `Pick ${i + 1}${title}`));
}

const API_URL = `http://localhost:${process.env.E2E_API_PORT ?? 8201}`;

/**
 * The host closes voting straight against the API, with the seeded admin session and a pinned
 * tie-break seed (X-FNH-Test-Seed, honoured only when ENVIRONMENT=test). CSRF is double-submit,
 * so any matching cookie/header pair passes.
 */
export async function hostClosesVoting(
  request: APIRequestContext,
  night: SeededNight,
  seed = "42",
): Promise<{
  status: string;
  result: { winner_option_id: string } | null;
  options: { id: string; title: string }[];
}> {
  const csrf = "e2e-host-csrf";
  const response = await request.post(
    `${API_URL}/api/v1/sessions/${night.sessionId}/close-voting`,
    {
      headers: {
        Cookie: `fnh_session=${night.hostCookie}; fnh_csrf=${csrf}`,
        "X-FNH-CSRF": csrf,
        "X-FNH-Test-Seed": seed,
      },
    },
  );
  expect(response.status()).toBe(200);
  return response.json();
}

/** The host ends the night (`tonight → closed`) straight against the API, like hostClosesVoting. */
export async function hostClosesNight(request: APIRequestContext, night: SeededNight) {
  const csrf = "e2e-host-csrf";
  const response = await request.post(`${API_URL}/api/v1/sessions/${night.sessionId}/close`, {
    headers: { Cookie: `fnh_session=${night.hostCookie}; fnh_csrf=${csrf}`, "X-FNH-CSRF": csrf },
  });
  expect(response.status()).toBe(200);
}
