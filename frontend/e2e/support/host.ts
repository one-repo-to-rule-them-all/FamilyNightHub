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
 * ADR-0014 sign-in: username (or email) + password on /login, landing on the portal's Home.
 * The seed gives every account the test password `night.password`.
 */
export async function signInWithPassword(
  page: Page,
  night: Pick<SeededHousehold, "adminUsername" | "password">,
  identifier: string = night.adminUsername,
) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(night.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/host$/);
  await expect(page.locator('[data-screen="portal-home"]')).toBeVisible();
}

/**
 * "Forgot password?": request a link on /login, read it from MailHog, open it and choose a new
 * password (POST /auth/verify now requires `new_password`), landing on /host. `except` lists links
 * already used for this address (see magicLinkToken). Returns the token.
 */
export async function signInWithMagicLink(
  page: Page,
  email: string,
  except: string[] = [],
  newPassword = "a brand new e2e password",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const token = await magicLinkToken(email, except);
  await page.goto(`/auth/callback?token=${token}`);
  await page.getByLabel("New password").fill(newPassword);
  await page.getByLabel("Type it again").fill(newPassword);
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page).toHaveURL(/\/host$/);
  await expect(page.locator('[data-screen="portal-home"]')).toBeVisible();
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

/** Opens a portal destination through the nav: sidebar from md up, bottom tabs or More below. */
export async function portalNav(page: Page, label: string) {
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  if (!phone) {
    await page
      .getByRole("navigation", { name: "Portal" })
      .getByRole("link", { name: label })
      .click();
    return;
  }
  const tabs = page.getByRole("navigation", { name: "Portal" });
  // A tab's name includes its badge ("2 things need you Home"): match the label as a substring.
  const tab = tabs.getByRole("link", { name: label });
  if ((await tab.count()) > 0) {
    await tab.first().click();
    return;
  }
  await tabs.getByRole("button", { name: "More" }).click();
  await page.getByTestId("portal-more").getByRole("link", { name: label }).click();
}

/** Sign out from the portal shell: the sidebar footer, or the More sheet on a phone. */
export async function signOut(page: Page) {
  await expect(
    page.getByTestId("signed-in-as").or(page.locator("[data-screen^=portal-]")).first(),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page
      .getByRole("navigation", { name: "Portal" })
      .getByRole("button", { name: "More" })
      .click();
    await page.getByTestId("portal-more").getByTestId("sign-out").click();
  } else {
    await page.getByTestId("sign-out").first().click();
  }
  await expect(page).toHaveURL(/\/login$/);
}

/**
 * Pairs this signed-in browser as the living-room TV the way the owner portal offers it for any
 * night (Settings → This browser → "Use as the TV…", ADR-0002). The account session is dropped,
 * and /tv follows the household's current night.
 */
export async function pairAsTv(tv: Page) {
  await tv.goto("/admin/settings");
  await tv.getByTestId("use-as-tv").click();
  await tv
    .getByTestId("use-as-tv-confirm")
    .getByRole("button", { name: "Yes, make it the TV" })
    .click();
  await expect(tv).toHaveURL(/\/tv(\/[0-9a-f-]{36})?$/);
}
