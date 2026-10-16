import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page } from "@playwright/test";

import type { SeededNight } from "./seed";

/**
 * Signs a browser context in as the seeded admin by setting the `fnh_session` cookie the seed
 * signed (same signer as POST /auth/verify). The magic-link path itself is covered in
 * join.spec.ts; host/TV tests start signed in so they don't depend on mail delivery timing.
 */
export async function signInAsHost(context: BrowserContext, night: SeededNight, baseURL: string) {
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
