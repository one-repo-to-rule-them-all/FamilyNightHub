import { type Page } from "@playwright/test";

import { expectNoAxeViolations, hostClosesNight, joinAs, pinFor, typePin } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/**
 * Ratings (Phase 2): nobody rates during the movie, so after the night the phone's Home asks
 * "How was *Movie*?" (guest-home T7). Two people share one phone, each switches in with their PIN
 * and taps their stars, and the family average shows on the night and in history. Every wait is on
 * a server-confirmed state.
 */
function rowFor(page: Page, name: string) {
  return page.getByTestId("rating-row").filter({ hasText: name });
}

/**
 * The shared-phone switch from a closed night (guest-home §5 H0): the app bar's person button →
 * their tile → their PIN. A switch is an arrival, and with no live night that is Home.
 */
async function switchToHome(page: Page, name: string) {
  await page.getByTestId("app-bar-person").click();
  await page
    .getByTestId("switch-sheet")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await typePin(page, pinFor(name));
  await expect(page.getByTestId("pin-sheet")).toHaveCount(0);
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
}

test.describe("ratings", () => {
  test("two people on a shared phone rate the movie and see the family average", async ({
    page,
    request,
  }) => {
    // Both were at the night (issue #91: only they may rate it).
    const night = seedNight({ movies: 3, tonight: true, attended: true });
    const [first, second] = night.people;
    await joinAs(page, night, [first, second]);

    // During the movie the stars stay folded away behind "Rate it now".
    await page.goto(`/s/${night.sessionId}`);
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "tonight");
    await expect(page.getByRole("button", { name: /Rate it/ })).toBeVisible();
    await expect(page.getByTestId("rating-panel")).toHaveCount(0);

    await hostClosesNight(request, night);

    // Next time the phone opens the app (no live night), Home's Tonight card asks (T7).
    await page.goto("/");
    await expect(page.locator('[data-screen="home"]')).toBeVisible();
    const card = page.getByTestId("tonight-card");
    await expect(card).toHaveAttribute("data-state", "T7");
    await expect(card.getByRole("heading", { name: /^How was .+\?$/ })).toBeVisible();
    await expectNoAxeViolations(page);
    await card.getByTestId("primary-action").click();

    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "closed");
    const panel = page.getByTestId("rating-panel");
    await expect(panel.getByTestId("family-average")).toHaveText("No ratings yet.");
    await expectNoAxeViolations(page);

    // ADR-0014: the phone rates as its current person (the last picked, `second`) only.
    await expect(page.getByTestId("rating-row")).toHaveCount(1);
    await rowFor(page, second).getByRole("radio", { name: "5 stars" }).click();
    await expect(panel.getByTestId("family-average")).toHaveText(
      "Family average: 5.0 from 1 rating",
    );
    // The other person on the phone switches with their PIN; Home still asks, for them.
    await switchToHome(page, first);
    await expect(page.getByTestId("tonight-card")).toHaveAttribute("data-state", "T7");
    await page.getByTestId("tonight-card").getByTestId("primary-action").click();
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "closed");
    await expect(page.getByTestId("rating-row")).toHaveCount(1);
    await rowFor(page, first).getByRole("radio", { name: "4 stars" }).click();
    await expect(panel.getByTestId("family-average")).toHaveText(
      "Family average: 4.5 from 2 ratings",
    );
    await expect(rowFor(page, first).getByRole("radio", { name: "4 stars" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await switchToHome(page, second);
    await page.goto(`/s/${night.sessionId}`);
    await expect(rowFor(page, second).getByRole("radio", { name: "5 stars" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.goto("/history?tab=family");
    await expect(page.getByTestId("history-rating")).toHaveText(
      "Family rating: 4.5 from 2 ratings",
    );
    await expectNoAxeViolations(page);

    // Everyone on this phone has rated: Home has nothing to ask (T0).
    await page.goto("/");
    await expect(page.locator('[data-screen="home"]')).toBeVisible();
    await expect(page.getByTestId("tonight-card")).toHaveAttribute("data-state", "T0");
    await expect(page.getByTestId("rate-prompt")).toHaveCount(0);
  });
});
