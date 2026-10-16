import { type Browser, type Page } from "@playwright/test";

import { expectNoAxeViolations, signInAsHost } from "./support/host";
import { hostClosesVoting, joinAs, newPhone } from "./support/phones";
import { expect, type SeededNight, seedNight, test } from "./support/seed";

/**
 * Approval and pick-one nights end to end (ADR-0010): the host picks the method on the draft,
 * opens voting, phones fill the method's ballot, the host closes with a pinned seed, and the TV
 * shows the winner with scores in the method's unit.
 */

/** A phone ballot poster, picked or not. */
const card = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^(Picked )?${title}`) });

async function hostOpensVotingWith(
  browser: Browser,
  baseURL: string,
  night: SeededNight,
  method: "Approval" | "Pick one",
) {
  const context = await browser.newContext({ baseURL });
  await signInAsHost(context, night, baseURL);
  const host = await context.newPage();
  await host.goto(`/host/${night.sessionId}`);
  const picker = host.getByTestId("voting-method");
  await expect(picker.getByRole("radio", { name: /^Top 3/ })).toBeChecked();
  await picker.getByRole("radio", { name: new RegExp(`^${method}`) }).check();
  await expect(picker.getByRole("radio", { name: new RegExp(`^${method}`) })).toBeChecked();
  await expectNoAxeViolations(host);
  await host.getByRole("button", { name: "Open voting" }).click();
  await expect(host.getByTestId("night-status")).toHaveText(/voting/i);
  await expect(host.getByTestId("voting-method")).toHaveCount(0); // locked with the shortlist
  return host;
}

async function tvShowsTheResult(browser: Browser, baseURL: string, night: SeededNight) {
  // Reduced motion: the reveal lands on the stored winner without the cosmetic spin.
  const context = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  await signInAsHost(context, night, baseURL);
  const tv = await context.newPage();
  await tv.goto(`/tv/${night.sessionId}`);
  await expect(tv.getByTestId("tv-winner")).toBeVisible();
  return tv;
}

/** Open the ballot. A phone holding several people asks "Who's voting?" first. */
async function startVoting(page: Page, night: SeededNight, name: string, shared = false) {
  await page.getByRole("link", { name: "Vote now" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${night.sessionId}$`));
  if (shared) await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByTestId("voting-as")).toHaveText(name);
}

test.describe("voting methods", () => {
  test("a pick-one night: one tap each, a tie settled by the pinned seed", async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const night = seedNight({ movies: 3 });
    const [paddington, spirited, ironGiant] = night.movies;
    await hostOpensVotingWith(browser, baseURL!, night, "Pick one");

    await joinAs(page, night, ["Ava", "Mia"]);
    await startVoting(page, night, "Ava", true);
    await expect(page.getByRole("heading", { name: "Pick one" })).toBeVisible();
    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    // A second poster replaces the first: one pick at a time.
    await card(page, paddington).click();
    await card(page, spirited).click();
    await expect(card(page, spirited)).toHaveAttribute("aria-pressed", "true");
    await expect(card(page, paddington)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("pick-count")).toHaveText("1 of 1 picked");
    await expectNoAxeViolations(page);
    await done.click();
    await expect(page.getByRole("heading", { name: "Thanks, Ava!" })).toBeVisible();
    await expect(page.getByTestId("saved-picks").getByRole("listitem")).toHaveText([
      `Picked${spirited}`,
    ]);

    await page.getByRole("button", { name: "Pass to next person" }).click();
    await page.getByRole("button", { name: /^Mia/ }).click();
    await card(page, paddington).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Thanks, Mia!" })).toBeVisible();

    // Paddington 1, Spirited Away 1: a pick-one tie goes straight to the seeded lottery.
    const closed = await hostClosesVoting(request, night, "20261015");
    const winner = closed.options.find((o) => o.id === closed.result?.winner_option_id)!.title;
    expect([paddington, spirited]).toContain(winner);

    const tv = await tvShowsTheResult(browser, baseURL!, night);
    await expect(tv.getByRole("heading", { name: winner })).toBeVisible();
    await expect(tv.getByTestId("tv-tiebreak")).toHaveText("Tie broken by a coin flip");
    const loser = winner === paddington ? spirited : paddington;
    await expect(tv.getByTestId("tv-scores").getByRole("listitem")).toHaveText([
      `1. ${winner}1 vote`,
      `2. ${loser}1 vote`,
      `3. ${ironGiant}0 votes`,
    ]);
    await expectNoAxeViolations(tv);
    await expect(page.getByTestId("winner-title")).toHaveText(winner);
  });

  test("an approval night: tick several, sole approvals break the tie", async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const night = seedNight({ movies: 4 });
    const [paddington, spirited, ironGiant, coco] = night.movies;
    await hostOpensVotingWith(browser, baseURL!, night, "Approval");

    // Ava ticks three, then unticks one: Paddington + Iron Giant.
    await joinAs(page, night, ["Ava"]);
    await startVoting(page, night, "Ava");
    await expect(page.getByRole("heading", { name: "Which would you watch?" })).toBeVisible();
    for (const title of [paddington, ironGiant, coco]) await card(page, title).click();
    await expect(page.getByTestId("pick-count")).toHaveText("3 movies picked");
    await card(page, coco).click();
    await expect(card(page, coco)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("pick-count")).toHaveText("2 movies picked");
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("saved-picks").getByRole("listitem")).toHaveText([
      `Picked${paddington}`,
      `Picked${ironGiant}`,
    ]);

    // Leo approves Iron Giant alone; Mia approves Paddington and Spirited Away.
    const leo = await newPhone(browser);
    await joinAs(leo, night, ["Leo"]);
    await startVoting(leo, night, "Leo");
    await card(leo, ironGiant).click();
    await leo.getByRole("button", { name: "Done" }).click();
    await expect(leo.getByRole("heading", { name: "Thanks, Leo!" })).toBeVisible();

    const mia = await newPhone(browser);
    await joinAs(mia, night, ["Mia"]);
    await startVoting(mia, night, "Mia");
    await card(mia, paddington).click();
    await card(mia, spirited).click();
    await mia.getByRole("button", { name: "Done" }).click();
    await expect(mia.getByRole("heading", { name: "Thanks, Mia!" })).toBeVisible();

    // Paddington 2 and Iron Giant 2 approvals; only Iron Giant was approved alone.
    const closed = await hostClosesVoting(request, night, "42");
    const winner = closed.options.find((o) => o.id === closed.result?.winner_option_id)!.title;
    expect(winner).toBe(ironGiant);

    const tv = await tvShowsTheResult(browser, baseURL!, night);
    await expect(tv.getByRole("heading", { name: ironGiant })).toBeVisible();
    await expect(tv.getByTestId("tv-tiebreak")).toHaveText(
      "Tie broken by who was picked alone most often",
    );
    await expect(tv.getByTestId("tv-scores").getByRole("listitem")).toHaveText([
      `1. ${ironGiant}2 approvals`,
      `2. ${paddington}2 approvals`,
      `3. ${spirited}1 approval`,
      `4. ${coco}0 approvals`,
    ]);
    await expectNoAxeViolations(tv);
    await expect(leo.getByTestId("winner-title")).toHaveText(ironGiant);
  });
});
