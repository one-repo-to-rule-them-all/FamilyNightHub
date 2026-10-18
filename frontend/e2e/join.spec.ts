import { signInWithMagicLink, signInWithPassword, signOut } from "./support/host";
import { MAILHOG_URL } from "./support/mail";
import { expectNoAxeViolations, pinFor, typePin } from "./support/phones";
import { expect, test } from "./support/seed";

test.describe("phone join flow", () => {
  test("join with the night code, then pick an avatar and choose a PIN", async ({
    page,
    night,
  }) => {
    await page.goto(`/j/${night.slug}`);
    await expect(page.getByRole("heading", { name: "Join movie night" })).toBeVisible();
    await expectNoAxeViolations(page);

    // Forgiving input: lower case with a dash still makes the canonical code, and a complete
    // code joins by itself (no button press).
    const code = page.getByLabel("Night code");
    await code.fill(`${night.nightCode.slice(0, 3).toLowerCase()}-${night.nightCode.slice(3)}`);
    await expect(page).toHaveURL(/\/who$/);
    await expect(page.locator('[data-screen="who"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
    // Tiles come from GET /api/v1/people for this household.
    for (const name of night.people) {
      await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expectNoAxeViolations(page);

    // ADR-0014: a first claim chooses the person's 6-digit PIN (S3c), typed twice.
    const leo = page.getByRole("button", { name: /^Leo/ });
    await leo.click();
    await expect(page.locator('[data-screen="pin-create"]')).toBeVisible();
    await expectNoAxeViolations(page);
    await typePin(page, pinFor("Leo"));
    await expect(page.getByTestId("pin-sheet")).toContainText("Type it again");
    // A mismatch goes back to step 1 without sending anything (AC-3.2).
    await typePin(page, "999999");
    await expect(page.getByTestId("pin-message")).not.toBeEmpty();
    await expect(page.getByTestId("pin-sheet")).not.toContainText("Type it again");
    await typePin(page, pinFor("Leo"));
    await expect(page.getByTestId("pin-sheet")).toContainText("Type it again");
    await typePin(page, pinFor("Leo"));

    // The draft night isn't open yet: the phone waits on it, as Leo.
    await expect(page).toHaveURL(new RegExp(`/s/${night.sessionId}$`));
    await expect(page.getByRole("heading", { name: "Almost ready" })).toBeVisible();

    // The binding lives on the server, keyed by the device cookie: /who still says it's Leo.
    await page.goto("/who");
    await expect(page.getByRole("button", { name: /^Leo/ })).toHaveAttribute(
      "data-binding",
      "mine",
    );
    await expect(page.getByRole("button", { name: /^Leo/ })).toContainText("That's you");
  });

  test("a wrong code shows the server's generic error", async ({ page, night }) => {
    await page.goto(`/j/${night.slug}`);
    const wrong = night.nightCode === "ZZZZZZ" ? "YYYYYY" : "ZZZZZZ";
    await page.getByLabel("Night code").fill(wrong);

    await expect(page.getByRole("alert").filter({ hasText: "code" })).toContainText(
      "That code didn't work",
    );
    await expect(page).toHaveURL(new RegExp(`/j/${night.slug}$`));
  });

  test("lookalike characters are flagged before anything is sent", async ({ page, night }) => {
    await page.goto(`/j/${night.slug}`);
    await page.getByLabel("Night code").fill("ABC23O");

    await expect(page.getByText(/never use O/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Join" })).toBeDisabled();
    await expect(page).toHaveURL(new RegExp(`/j/${night.slug}$`));
  });

  test("/who without a device cookie goes home", async ({ page }) => {
    await page.goto("/who");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Family Night Hub" })).toBeVisible();
  });
});

test.describe("host sign-in", () => {
  test("username or email + password signs in; a wrong password gets one generic answer", async ({
    page,
    night,
  }) => {
    await page.goto("/login");
    await expect(page.locator('[data-screen="admin-login"]')).toBeVisible();
    await expectNoAxeViolations(page);

    // Wrong password and unknown account read the same (no enumeration, ADR-0014).
    const answers: string[] = [];
    for (const identifier of [night.adminUsername, "nobody-here@e2e.test"]) {
      await page.getByLabel("Username or email").fill(identifier);
      await page.getByLabel("Password").fill("not the right password");
      await page.getByRole("button", { name: "Sign in" }).click();
      const error = page.getByTestId("api-error-message");
      await expect(error).toBeVisible();
      answers.push((await error.textContent()) ?? "");
    }
    expect(answers[0]).toBe(answers[1]);
    await expect(page).toHaveURL(/\/login$/);

    await signInWithPassword(page, night);
    await expect(page.getByTestId("signed-in-as")).toContainText(night.householdName);
    await expectNoAxeViolations(page);

    // The email works as the identifier too.
    await page.context().clearCookies();
    await signInWithPassword(page, night, night.adminEmail);
  });

  test("forgot password: the emailed link sets a new password, and sign out ends it", async ({
    page,
    night,
  }) => {
    test.skip(!MAILHOG_URL, "needs MailHog (set MAILHOG_URL); see 07-cicd.md");

    // The reset screen answers the same for any address.
    await page.goto("/login");
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.getByLabel("Email").fill("nobody-here@e2e.test");
    await page.getByRole("button", { name: "Email me a reset link" }).click();
    await expect(page.getByTestId("magic-link-sent")).toBeVisible();
    const generic = await page.getByTestId("magic-link-sent").textContent();

    const fresh = "a brand new e2e password";
    const token = await signInWithMagicLink(page, night.adminEmail, [], fresh);
    await expect(page.getByTestId("signed-in-as")).toContainText(night.householdName);

    // Links are single-use: the same token again is refused by the server.
    await page.goto(`/auth/callback?token=${token}`);
    await page.getByLabel("New password").fill("another e2e password here");
    await page.getByLabel("Type it again").fill("another e2e password here");
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await expect(page.getByTestId("api-error-message")).toBeVisible();
    await expect(page.getByRole("link", { name: "Send a new link" })).toBeVisible();

    // Sign out lives in the portal shell (sidebar on desktop, More sheet on a phone).
    await page.goto("/host");
    await signOut(page);
    await page.goto("/host");
    await expect(page).toHaveURL(/\/login$/);

    // The old password stopped working; the new one signs in.
    await page.getByLabel("Username or email").fill(night.adminUsername);
    await page.getByLabel("Password").fill(night.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("api-error-message")).toBeVisible();
    await signInWithPassword(page, { adminUsername: night.adminUsername, password: fresh });

    expect(generic).toBeTruthy();
  });

  test("an unknown callback token shows the server's error and a way back", async ({ page }) => {
    // Well-formed (43 chars, like a real token) so it reaches the server's lookup.
    await page.goto(`/auth/callback?token=${"x".repeat(43)}`);
    await page.getByLabel("New password").fill("a perfectly fine password");
    await page.getByLabel("Type it again").fill("a perfectly fine password");
    await page.getByRole("button", { name: "Save and sign in" }).click();

    await expect(page.getByTestId("api-error-message")).toBeVisible();
    await expect(page.getByRole("link", { name: "Send a new link" })).toHaveAttribute(
      "href",
      "/login",
    );
    await expectNoAxeViolations(page);
  });

  test("a callback without a token asks for the link again", async ({ page }) => {
    await page.goto("/auth/callback");

    await expect(page.getByText(/This link is incomplete/)).toBeVisible();
    await expect(page.getByTestId("api-error-message")).toHaveCount(0);
  });

  test("/host without a session goes to /login", async ({ page }) => {
    await page.goto("/host");
    await expect(page).toHaveURL(/\/login$/);
  });
});
