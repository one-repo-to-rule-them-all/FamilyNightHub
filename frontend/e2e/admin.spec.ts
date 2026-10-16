import { expect, seedHousehold, seedNight, test } from "./support/seed";
import { expectNoAxeViolations, signInAsHost } from "./support/host";

/**
 * Phase 2 admin: the owned library's bulk add (ADR-0007) against tmdb-fake, and a winner
 * correction (ADR-0006) that /history then shows. Each test seeds its own household.
 */

test("bulk add resolves an ambiguous title and marks everything owned", async ({
  page,
  context,
  baseURL,
}) => {
  const house = seedHousehold();
  await signInAsHost(context, house, baseURL!);
  await page.goto("/admin/movies");
  await expect(page.getByRole("heading", { name: "Movies", level: 1 })).toBeVisible();
  await expect(page.getByTestId("library-table")).toContainText("No titles match.");
  await expect(page.getByTestId("tmdb-attribution")).toContainText("not endorsed or certified");
  await expectNoAxeViolations(page);

  await page
    .getByLabel("One title per line, optional (year)")
    .fill("Coco\nToy\nGrandma's Tape (1988)\n");
  await expect(page.getByText("3 titles")).toBeVisible();
  await page.getByRole("button", { name: "Add to library" }).click();

  const lines = page.getByTestId("bulk-line");
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toHaveAttribute("data-status", "matched");
  await expect(lines.nth(0)).toContainText("added: Coco (2017)");
  await expect(lines.nth(1)).toHaveAttribute("data-status", "ambiguous");
  await expect(lines.nth(2)).toHaveAttribute("data-status", "not_found");

  const toy = page.getByRole("group", { name: /Toy — which one did you mean/ });
  await expect(toy.getByRole("radio")).toHaveCount(5); // 3 candidates, typed, skip
  await toy.getByRole("radio", { name: "Toy Story 2 (1999)" }).check();
  await page
    .getByRole("group", { name: /Grandma's Tape \(1988\) — no match/ })
    .getByRole("radio", { name: "Add as typed" })
    .check();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Confirm choices" }).click();

  await expect(lines.nth(1)).toContainText("added: Toy Story 2 (1999)");
  await expect(lines.nth(2)).toContainText("added as typed");
  await expect(page.getByRole("button", { name: "Confirm choices" })).toHaveCount(0);

  const table = page.getByTestId("library-table");
  for (const title of ["Coco", "Toy Story 2", "Grandma's Tape"]) {
    await expect(table.getByRole("checkbox", { name: `Owned: ${title}` })).toBeChecked();
  }
  await expect(table).toContainText("Typed title (no TMDB match)");

  const blocked = table.getByRole("checkbox", { name: "Blocked: Coco" });
  await blocked.click();
  await expect(blocked).toBeChecked();
  await page.getByLabel("Show").selectOption("blocked");
  await expect(table.getByTestId("library-title")).toHaveText(["Coco (2017)"]);
});

test("an admin corrects a winner and /history shows it", async ({ page, context, baseURL }) => {
  const night = seedNight({ movies: 3, tonight: true });
  await signInAsHost(context, night, baseURL!);
  await page.goto("/admin/history");

  const winnerCell = page.getByTestId("admin-history-winner");
  await expect(winnerCell).toHaveCount(1);
  const original = (await winnerCell.textContent())!.trim();
  expect(night.movies).toContain(original);
  const corrected = night.movies.find((title) => title !== original)!;

  await page.getByRole("button", { name: "Correct winner" }).click();
  const form = page.getByRole("form", { name: /Correct the winner/ });
  await expect(form).toContainText(`now ${original}`);
  await expect(form.getByRole("radio")).toHaveCount(2);
  await form.getByRole("radio", { name: corrected }).check();
  const confirm = form.getByRole("button", { name: "Confirm correction" });
  await expect(confirm).toBeDisabled(); // a reason is required
  await form.getByLabel("Reason (kept in the audit log)").fill("The DVD was scratched");
  await expectNoAxeViolations(page);
  await confirm.click();

  await expect(page.getByTestId("correction-notice")).toHaveText(
    `Winner corrected to ${corrected}.`,
  );
  await expect(winnerCell).toHaveText(corrected);

  await page.goto("/history");
  await expect(page.getByTestId("history-winner")).toHaveText([corrected]);
});
