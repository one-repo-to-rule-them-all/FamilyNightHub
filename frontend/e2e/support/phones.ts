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

/** Join with the night code, then claim each person on /who (server-confirmed). */
export async function joinAs(
  page: Page,
  night: Pick<SeededNight, "slug" | "nightCode">,
  names: string[],
) {
  await page.goto(`/j/${night.slug}`);
  await page.getByLabel("Night code").fill(night.nightCode);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page).toHaveURL(/\/who$/);
  for (const name of names) {
    const tile = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await tile.click();
    await expect(tile).toHaveAttribute("data-binding", "mine");
  }
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
