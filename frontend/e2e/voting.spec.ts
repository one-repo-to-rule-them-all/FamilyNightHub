import { type Page } from "@playwright/test";

import {
  apiFromPhone,
  expectNoAxeViolations,
  hostClosesVoting,
  joinAs,
  newPhone,
} from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/** The snapshot is polled every 5s until SSE lands (useLiveSession), so reveal waits a cycle. */
const REVEAL_TIMEOUT = 15_000;

const poster = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^(Pick \\d )?${title}`) });

/** Tap posters in order, then Done; the confirmation lists what the server saved. */
async function vote(page: Page, name: string, titles: string[]) {
  await expect(page.getByTestId("voting-as")).toHaveText(name);
  for (const title of titles) await poster(page, title).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: `Thanks, ${name}!` })).toBeVisible();
  const saved = page.getByTestId("saved-picks").getByRole("listitem");
  await expect(saved).toHaveText(titles.map((title, i) => `Pick ${i + 1}${title}`));
}

test.describe("phone voting", () => {
  test("two phones vote for their own people and see the same winner", async ({
    page,
    browser,
    request,
  }) => {
    // 4 movies → ballot_size 3 (ADR-0006).
    const night = seedNight({ movies: 4, openVoting: true });
    const [paddington, spirited, ironGiant, coco] = night.movies;

    // Phone A is shared by Ava and Mia; phone B is Leo's.
    await joinAs(page, night, ["Ava", "Mia"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);

    await page.getByRole("link", { name: "Vote now" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${night.sessionId}$`));
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-live", "reconnecting");
    await expect(page.getByRole("heading", { name: "Who's voting?" })).toBeVisible();
    await expectNoAxeViolations(page);

    // Tap-to-rank: 1, 2, 3; a second tap clears and the next tap takes the freed rank.
    await page.getByRole("button", { name: /^Ava/ }).click();
    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    await poster(page, spirited).click();
    await expect(done).toBeEnabled();
    await poster(page, coco).click();
    await poster(page, paddington).click();
    await expect(poster(page, paddington)).toHaveAttribute("data-rank", "3");
    await poster(page, paddington).click();
    await expect(poster(page, paddington)).not.toHaveAttribute("data-rank");
    await expect(page.getByTestId("pick-count")).toHaveText("2 of 3 picked");
    await expectNoAxeViolations(page);
    await done.click();
    await expect(page.getByRole("heading", { name: "Thanks, Ava!" })).toBeVisible();
    await expect(page.getByTestId("saved-picks").getByRole("listitem")).toHaveText([
      `Pick 1${spirited}`,
      `Pick 2${coco}`,
    ]);

    // Pass the phone: back to the grid, where Ava now shows as voted (from the server).
    await page.getByRole("button", { name: "Pass to next person" }).click();
    await expect(page.getByRole("button", { name: /^Ava/ })).toHaveAttribute("data-voted", "true");
    await page.getByRole("button", { name: /^Mia/ }).click();
    // A full ballot ignores a 4th tap.
    await poster(page, spirited).click();
    await poster(page, paddington).click();
    await poster(page, coco).click();
    await poster(page, ironGiant).click();
    await expect(poster(page, ironGiant)).not.toHaveAttribute("data-rank");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Thanks, Mia!" })).toBeVisible();
    await expect(page.getByTestId("saved-picks").getByRole("listitem")).toHaveText([
      `Pick 1${spirited}`,
      `Pick 2${paddington}`,
      `Pick 3${coco}`,
    ]);

    // One person on the phone: straight to the ballot, and nobody to pass to.
    await phoneB.getByRole("link", { name: "Vote now" }).click();
    await expect(phoneB.getByRole("heading", { name: "Rank your favourites" })).toBeVisible();
    await vote(phoneB, "Leo", [paddington]);
    await expect(phoneB.getByRole("button", { name: "Pass to next person" })).toHaveCount(0);

    // Host closes with a pinned seed; the server decides the winner once.
    // Spirited Away 3+3 = 6, Paddington 2+3 = 5, Coco 2+1 = 3: no tie.
    const closed = await hostClosesVoting(request, night);
    expect(closed.status).toBe("revealed");
    const winner = closed.options.find((o) => o.id === closed.result?.winner_option_id)?.title;
    expect(winner).toBe(spirited);

    for (const phone of [page, phoneB]) {
      await expect(phone.getByTestId("winner-title")).toHaveText(spirited, {
        timeout: REVEAL_TIMEOUT,
      });
      await expect(phone.getByRole("heading", { name: "The winner is…" })).toBeVisible();
      await expect(phone.getByTestId("ballot-count")).toHaveText("3 people voted");
    }
    await expectNoAxeViolations(phoneB);

    // History lists the night with its winner and turnout.
    await phoneB.goto("/history");
    const entry = phoneB.getByTestId("history-list").getByRole("listitem").first();
    await expect(entry.getByTestId("history-winner")).toHaveText(spirited);
    await expect(entry.getByTestId("history-turnout")).toHaveText("3 people voted");
    await expectNoAxeViolations(phoneB);

    await phoneB.context().close();
  });

  test("a phone can't vote for someone bound to another phone", async ({ page, browser }) => {
    const night = seedNight({ movies: 3, openVoting: true });
    const [first] = night.movies;

    await joinAs(page, night, ["Ava"]);
    const people = (await apiFromPhone(page, "GET", "/people")).body as {
      id: string;
      name: string;
    }[];
    const ava = people.find((p) => p.name === "Ava")!;

    // Phone B asks for Ava too: that is only a pending claim, so the ballot never offers her.
    const phoneB = await newPhone(browser);
    await phoneB.goto(`/j/${night.slug}`);
    await phoneB.getByLabel("Night code").fill(night.nightCode);
    await phoneB.getByRole("button", { name: "Join" }).click();
    const avaOnB = phoneB.getByRole("button", { name: /^Ava/ });
    await avaOnB.click();
    await expect(avaOnB).toHaveAttribute("data-binding", "pending");
    await phoneB.goto(`/s/${night.sessionId}`);
    await expect(phoneB.getByRole("link", { name: "Pick who you are" })).toBeVisible();

    // Forcing it through the API is refused by the server, whatever the UI shows.
    const forced = await apiFromPhone(phoneB, "PUT", `/sessions/${night.sessionId}/ballots`, {
      person_id: ava.id,
      ranks: [{ option_id: "00000000-0000-0000-0000-000000000000", rank: 1 }],
    });
    expect(forced.status).toBe(403);
    expect(forced.body).toMatchObject({ error: { message: "This phone can't vote as them" } });

    // A stale ballot screen shows the server's own message: Ava is released from phone A
    // after its ballot loaded, then Done is refused.
    await page.goto(`/s/${night.sessionId}`);
    await expect(page.getByTestId("voting-as")).toHaveText("Ava");
    const released = await apiFromPhone(page, "DELETE", `/devices/me/people/${ava.id}`);
    expect(released.status).toBe(204);
    await poster(page, first).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("api-error-message")).toHaveText("This phone can't vote as them");
    // The refusal refreshes who this phone is, so it now asks to pick again.
    await expect(page.getByRole("link", { name: "Pick who you are" })).toBeVisible();

    await phoneB.context().close();
  });

  test("a night still being set up says so", async ({ page }) => {
    const night = seedNight();
    await joinAs(page, night, ["Mia"]);
    // A draft night isn't live, so /who offers no link to it yet.
    await expect(page.getByTestId("go-to-night")).toHaveCount(0);
    await page.goto(`/s/${night.sessionId}`);
    await expect(page.getByRole("heading", { name: "Almost ready" })).toBeVisible();
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "draft");
    await expectNoAxeViolations(page);
  });
});
