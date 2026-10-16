import { type Page } from "@playwright/test";

import { expectNoAxeViolations, hostClosesNight, joinAs } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/**
 * Ratings (Phase 2): nobody rates during the movie, so after the night the phone's landing screen
 * asks "How was *Movie*?". Two people share one phone, each taps their stars, and the family
 * average shows on the night and in history. Every wait is on a server-confirmed state.
 */
function rowFor(page: Page, name: string) {
  return page.getByTestId("rating-row").filter({ hasText: name });
}

test.describe("ratings", () => {
  test("two people on a shared phone rate the movie and see the family average", async ({
    page,
    request,
  }) => {
    const night = seedNight({ movies: 3, tonight: true });
    const [first, second] = night.people;
    await joinAs(page, night, [first, second]);

    // During the movie the stars stay folded away behind "Rate it now".
    await page.goto(`/s/${night.sessionId}`);
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "tonight");
    await expect(page.getByRole("button", { name: "Rate it now" })).toBeVisible();
    await expect(page.getByTestId("rating-panel")).toHaveCount(0);

    await hostClosesNight(request, night);

    // Next time the phone opens the app, it asks.
    await page.goto("/who");
    const prompt = page.getByTestId("rate-prompt");
    await expect(prompt.getByRole("heading", { name: /^How was .+\?$/ })).toBeVisible();
    await expectNoAxeViolations(page);
    await prompt.getByTestId("rate-prompt-go").click();

    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "closed");
    const panel = page.getByTestId("rating-panel");
    await expect(panel.getByTestId("family-average")).toHaveText("No ratings yet.");
    await expectNoAxeViolations(page);

    await rowFor(page, first).getByRole("radio", { name: "4 stars" }).click();
    await expect(panel.getByTestId("family-average")).toHaveText(
      "Family average: 4.0 from 1 rating",
    );
    await rowFor(page, second).getByRole("radio", { name: "5 stars" }).click();
    await expect(panel.getByTestId("family-average")).toHaveText(
      "Family average: 4.5 from 2 ratings",
    );
    await expect(rowFor(page, first).getByRole("radio", { name: "4 stars" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(rowFor(page, second).getByRole("radio", { name: "5 stars" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.goto("/history");
    await expect(page.getByTestId("history-rating")).toHaveText(
      "Family rating: 4.5 from 2 ratings",
    );
    await expectNoAxeViolations(page);

    // Everyone on this phone has rated: the landing card is gone.
    await page.goto("/who");
    await expect(page.getByTestId("who-status")).toBeVisible();
    await expect(page.getByTestId("rate-prompt")).toHaveCount(0);
  });
});
