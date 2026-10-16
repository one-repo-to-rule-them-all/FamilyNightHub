import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { MAILHOG_URL, magicLinkToken } from "./support/mail";
import { expect, test } from "./support/seed";

/** WCAG 2.1 AA, as in Ctrl+Alt+Defeat's axe checks. */
async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe("phone join flow", () => {
  test("join with the night code, then pick an avatar", async ({ page, night }) => {
    await page.goto(`/j/${night.slug}`);
    await expect(page.getByRole("heading", { name: "Join movie night" })).toBeVisible();
    await expectNoAxeViolations(page);

    // Forgiving input: lower case with a dash still makes the canonical code.
    const code = page.getByLabel("Night code");
    await code.fill(`${night.nightCode.slice(0, 3).toLowerCase()}-${night.nightCode.slice(3)}`);
    await expect(code).toHaveValue(night.nightCode);
    await page.getByRole("button", { name: "Join" }).click();

    await expect(page).toHaveURL(/\/who$/);
    await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
    // Tiles come from GET /api/v1/people for this household.
    for (const name of night.people) {
      await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expectNoAxeViolations(page);

    const leo = page.getByRole("button", { name: /^Leo/ });
    await leo.click();

    // Server-derived: the refetched grid says this device is now Leo.
    await expect(leo).toHaveAttribute("data-binding", "mine");
    await expect(leo).toContainText("That's you");
    await expect(page.getByTestId("who-status")).toHaveText(
      "You're in as Leo. Voting opens on the TV.",
    );

    // The binding survives a reload: it lives on the server, keyed by the device cookie.
    await page.reload();
    await expect(page.getByRole("button", { name: /^Leo/ })).toHaveAttribute(
      "data-binding",
      "mine",
    );
  });

  test("a wrong code shows the server's generic error", async ({ page, night }) => {
    await page.goto(`/j/${night.slug}`);
    const wrong = night.nightCode === "ZZZZZZ" ? "YYYYYY" : "ZZZZZZ";
    await page.getByLabel("Night code").fill(wrong);
    await page.getByRole("button", { name: "Join" }).click();

    await expect(page.getByTestId("api-error-message")).toHaveText(
      "That code doesn't match tonight's night.",
    );
    await expect(page).toHaveURL(new RegExp(`/j/${night.slug}$`));
  });

  test("lookalike characters are flagged before anything is sent", async ({ page, night }) => {
    await page.goto(`/j/${night.slug}`);
    await page.getByLabel("Night code").fill("ABC23O");

    await expect(page.getByText("Night codes never use O. Check the TV again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Join" })).toBeDisabled();
  });

  test("/who without a device cookie goes home", async ({ page }) => {
    await page.goto("/who");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Family Night Hub" })).toBeVisible();
  });
});

test.describe("host sign-in", () => {
  test("the login page answers the same for any address", async ({ page, night }) => {
    await page.goto("/login");
    await expectNoAxeViolations(page);

    await page.getByLabel("Email").fill(night.adminEmail);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByTestId("magic-link-sent")).toHaveText(
      "If that address belongs to a host or admin, a sign-in link is on its way.",
    );
  });

  test("the emailed link signs the host in, and sign out ends it", async ({ page, night }) => {
    test.skip(!MAILHOG_URL, "needs MailHog (set MAILHOG_URL); see 07-cicd.md");

    await page.goto("/login");
    await page.getByLabel("Email").fill(night.adminEmail);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

    const token = await magicLinkToken(night.adminEmail);
    await page.goto(`/auth/callback?token=${token}`);

    await expect(page).toHaveURL(/\/host$/);
    await expect(page.getByTestId("signed-in-as")).toHaveText(
      `Signed in as E2E Host (admin) for ${night.householdName}.`,
    );
    await expectNoAxeViolations(page);

    // Links are single-use: the same token again is refused by the server.
    await page.goto(`/auth/callback?token=${token}`);
    await expect(page.getByTestId("api-error-message")).toHaveText(
      "This sign-in link is invalid or has expired.",
    );

    await page.goto("/host");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/host");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("an unknown callback token shows the server's error and a way back", async ({ page }) => {
    // Well-formed (43 chars, like a real token) so it reaches the server's lookup.
    await page.goto(`/auth/callback?token=${"x".repeat(43)}`);

    await expect(page.getByTestId("api-error-message")).toHaveText(
      "This sign-in link is invalid or has expired.",
    );
    await expect(page.getByRole("link", { name: "Send a new link" })).toHaveAttribute(
      "href",
      "/login",
    );
    await expectNoAxeViolations(page);
  });

  test("a truncated callback token asks for the link again", async ({ page }) => {
    await page.goto("/auth/callback?token=short");

    await expect(
      page.getByText("This sign-in link is incomplete. Open the link from your email again."),
    ).toBeVisible();
    await expect(page.getByTestId("api-error-message")).toHaveCount(0);
  });

  test("/host without a session goes to /login", async ({ page }) => {
    await page.goto("/host");
    await expect(page).toHaveURL(/\/login$/);
  });
});
