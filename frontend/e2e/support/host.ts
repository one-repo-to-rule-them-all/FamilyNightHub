import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page } from "@playwright/test";

import { magicLinkToken } from "./mail";
import type { SeededHousehold } from "./seed";

/**
 * Signs a browser context in as the seeded admin by setting the `fnh_session` cookie the seed
 * signed (same signer as POST /auth/verify). The magic-link path itself is covered in
 * join.spec.ts; host/TV tests start signed in so they don't depend on mail delivery timing.
 */
export async function signInAsHost(
  context: BrowserContext,
  night: SeededHousehold,
  baseURL: string,
) {
  await context.addCookies([
    {
      name: "fnh_session",
      value: night.hostCookie,
      url: baseURL,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

/**
 * The real sign-in: request a link on /login, read it from MailHog, open it, land on /host.
 * `except` lists links already used for this address (see magicLinkToken). Returns the token.
 */
export async function signInWithMagicLink(page: Page, email: string, except: string[] = []) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const token = await magicLinkToken(email, except);
  await page.goto(`/auth/callback?token=${token}`);
  await expect(page).toHaveURL(/\/host$/);
  await expect(page.getByTestId("signed-in-as")).toContainText("Signed in as E2E Host (admin)");
  return token;
}

/**
 * Pins the tie-break seed on this page's close-voting call (X-FNH-Test-Seed, honoured only with
 * ENVIRONMENT=test, 07-cicd.md), so the host closes through the real button.
 */
export async function pinTieBreakSeed(page: Page, seed: string) {
  await page.route("**/api/v1/sessions/*/close-voting", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-fnh-test-seed": seed },
    }),
  );
}

/** WCAG 2.1 AA, as in Ctrl+Alt+Defeat's axe checks. */
export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

/**
 * Casts a phone ballot through the API from inside the phone's page (same origin, its own device
 * cookie, real CSRF). The phone ballot screen (/s/[session]) is built in a separate PR; this keeps
 * the host/TV test independent of it.
 */
export async function castPhoneBallot(
  phone: Page,
  sessionId: string,
  personName: string,
  titles: string[],
): Promise<number> {
  return phone.evaluate(
    async ({ sessionId, personName, titles }) => {
      const json = async (path: string) =>
        (await fetch(`/api/v1${path}`, { credentials: "include" })).json();
      const { csrf_token } = (await json("/csrf")) as { csrf_token: string };
      const people = (await json("/people")) as { id: string; name: string }[];
      const night = (await json(`/sessions/${sessionId}`)) as {
        options: { id: string; title: string }[];
      };
      const person = people.find((p) => p.name === personName);
      const ranks = titles.map((title, i) => ({
        option_id: night.options.find((o) => o.title === title)?.id,
        rank: i + 1,
      }));
      const response = await fetch(`/api/v1/sessions/${sessionId}/ballots`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-FNH-CSRF": csrf_token },
        body: JSON.stringify({ person_id: person?.id, ranks }),
      });
      return response.status;
    },
    { sessionId, personName, titles },
  );
}
