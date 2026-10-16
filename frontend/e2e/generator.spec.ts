import { expectNoAxeViolations, signInAsHost } from "./support/host";
import { expect, seedNight, test } from "./support/seed";

/**
 * The host's "Roll candidates" panel (ADR-0007) against tmdb-fake: owned titles first, then the
 * household's streaming services (Disney Plus = TMDB provider 337), each added through the
 * shortlist endpoint with its own source.
 */
test.describe("candidate generator", () => {
  test("the host rolls, adds an owned and a streaming pick, re-rolls and opens voting", async ({
    page,
    baseURL,
  }) => {
    const night = seedNight({ owned: 2, providers: [337] });
    await signInAsHost(page.context(), night, baseURL as string);
    await page.goto(`/host/${night.sessionId}`);
    await expect(page.getByTestId("night-status")).toHaveText("Building the shortlist");

    // Before any roll the TMDB notice is already there.
    await expect(page.getByTestId("roll-tmdb-attribution")).toContainText(
      "not endorsed or certified by TMDB",
    );

    await page.getByLabel("How many").fill("4");
    await page.getByLabel("Genre").selectOption("Family");
    await page.getByRole("button", { name: "Roll candidates" }).click();

    const candidates = page.getByTestId("candidate");
    await expect(candidates).toHaveCount(4);
    // Owned first (both library titles), then streaming: the generator's source order.
    await expect(candidates.nth(0)).toHaveAttribute("data-source", "owned");
    await expect(candidates.nth(1)).toHaveAttribute("data-source", "owned");
    await expect(candidates.nth(2)).toHaveAttribute("data-source", "streaming");
    await expect(candidates.nth(3)).toHaveAttribute("data-source", "streaming");
    const titled = (title: string) =>
      candidates.filter({
        has: page.getByTestId("candidate-title").getByText(title, { exact: true }),
      });
    const toyStory = titled("Toy Story");
    await expect(toyStory.getByTestId("candidate-source")).toHaveText("Owned");
    await expect(toyStory.getByTestId("candidate-cert")).toHaveText("Rated G");
    await expect(candidates.nth(2).getByTestId("candidate-source")).toHaveText(
      "Streaming on Disney Plus",
    );
    // Streaming data is on screen, so JustWatch is credited (the response's own string).
    await expect(page.getByTestId("roll-justwatch-attribution")).toContainText(
      "Streaming availability data provided by JustWatch.",
    );
    await expect(page.getByTestId("roll-tmdb-unavailable")).toHaveCount(0);
    await expectNoAxeViolations(page);

    // Add the owned Toy Story and the first streaming pick.
    const streamingTitle = (await candidates
      .nth(2)
      .getByTestId("candidate-title")
      .textContent())!.trim();
    await toyStory.getByRole("button", { name: /^Add Toy Story/ }).click();
    await expect(page.getByTestId("shortlist-count")).toHaveText("1 of 8");
    await expect(toyStory).toContainText("Added");
    await candidates
      .nth(2)
      .getByRole("button", { name: /to shortlist$/ })
      .click();
    await expect(page.getByTestId("shortlist-count")).toHaveText("2 of 8");
    await expect(page.getByTestId("shortlist-item")).toHaveText([
      /Toy Story/,
      new RegExp(streamingTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    ]);

    // A re-roll skips what is already on the shortlist; the other owned title still leads.
    await page.getByRole("button", { name: "Re-roll" }).click();
    await expect(candidates.first().getByTestId("candidate-title")).toHaveText(
      "Grandma's Camcorder Classics",
    );
    await expect(titled("Toy Story")).toHaveCount(0);

    await page.getByRole("button", { name: "Open voting" }).click();
    await expect(page.getByTestId("night-status")).toHaveText("Voting");
    // The panel is for drafts only.
    await expect(page.getByRole("heading", { name: "Roll candidates" })).toHaveCount(0);
  });

  test("with TMDB down it rolls owned titles only, and stops adding at 8", async ({
    page,
    baseURL,
  }) => {
    // Seven typed titles already, so one pick fills the shortlist.
    const night = seedNight({ movies: 7, owned: 2, providers: [337] });
    await signInAsHost(page.context(), night, baseURL as string);
    // TMDB off or down: the API still rolls owned titles and says so. Forced here by rewriting the
    // real answer, since the shared tmdb-fake can't go down for one test.
    await page.route("**/api/v1/sessions/*/generate", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        candidates: { source: string }[];
        attribution: { tmdb: string; justwatch: string | null };
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          candidates: body.candidates.filter((c) => c.source === "owned"),
          tmdb_unavailable: true,
          attribution: { ...body.attribution, justwatch: null },
        },
      });
    });
    await page.goto(`/host/${night.sessionId}`);
    await expect(page.getByTestId("shortlist-count")).toHaveText("7 of 8");

    await page.getByRole("button", { name: "Roll candidates" }).click();
    await expect(page.getByTestId("roll-tmdb-unavailable")).toHaveText(
      "TMDB unavailable, owned titles only.",
    );
    const candidates = page.getByTestId("candidate");
    await expect(candidates).toHaveCount(2);
    await expect(page.getByTestId("roll-justwatch-attribution")).toHaveCount(0);
    await expect(page.getByTestId("roll-tmdb-attribution")).toContainText("TMDB");
    await expectNoAxeViolations(page);

    await candidates
      .first()
      .getByRole("button", { name: /to shortlist$/ })
      .click();
    await expect(page.getByTestId("shortlist-count")).toHaveText("8 of 8");
    await expect(page.getByTestId("roll-full")).toBeVisible();
    await expect(candidates.nth(1).getByRole("button", { name: /to shortlist$/ })).toBeDisabled();
  });
});
