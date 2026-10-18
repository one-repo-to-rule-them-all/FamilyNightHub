import {
  apiFromPhone,
  expectNoAxeViolations,
  hostClosesVoting,
  joinAs,
  newPhone,
  poster,
  switchTo,
  typePin,
  vote,
} from "./support/phones";
import { signInAsHost } from "./support/host";
import { expect, seedNight, test } from "./support/seed";

/** Generous: the reveal arrives live, but a dropped stream would fall back to the 5s poll. */
const REVEAL_TIMEOUT = 15_000;
/** /who polls every 5s while a claim is pending; /host's claim list polls too. */
const POLL = { timeout: 15_000 };

test.describe("phone voting", () => {
  test("two phones vote for their own people and see the same winner", async ({
    page,
    browser,
    request,
  }) => {
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    // 4 movies → ballot_size 3 (ADR-0006).
    const night = seedNight({ movies: 4, openVoting: true });
    const [paddington, spirited, ironGiant, coco] = night.movies;

    // Phone A is shared by Mia and Ava (Ava is current: the last one picked); phone B is Leo's.
    await joinAs(page, night, ["Mia", "Ava"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);

    // A phone with a current person lands straight on the night (guest-flow AC-2.3).
    await expect(page).toHaveURL(new RegExp(`/s/${night.sessionId}$`));
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-live", "ready");
    await expect(page.getByTestId("voting-as")).toHaveText("Ava");
    await expectNoAxeViolations(page);

    // Tap-to-rank: 1, 2, 3; a second tap clears and the next tap takes the freed rank.
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

    // Pass the phone: Mia needs her own PIN (ADR-0014: every switch).
    await switchTo(page, "Mia", { via: "pass" });
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
    // Everyone on this phone has voted: no one to pass to, and the switch sheet says Ava voted.
    await expect(page.getByRole("button", { name: "Pass to next person" })).toHaveCount(0);
    await page.getByTestId("current-chip").click();
    await expect(
      page.getByTestId("switch-sheet").getByRole("button", { name: /^Ava/ }),
    ).toContainText("Voted ✓");
    await page
      .getByTestId("switch-sheet")
      .getByRole("button", { name: "Back to Mia" })
      .last()
      .click();

    // One person on the phone: straight to the ballot, and nobody to pass to.
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
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    const night = seedNight({ movies: 3, openVoting: true });
    const [first] = night.movies;

    await joinAs(page, night, ["Ava"]);
    const people = (await apiFromPhone(page, "GET", "/people")).body as {
      id: string;
      name: string;
    }[];
    const ava = people.find((p) => p.name === "Ava")!;

    // Phone B is Leo's. Without Ava's PIN it can't act as her: forcing a ballot is refused.
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    const forced = await apiFromPhone(phoneB, "PUT", `/sessions/${night.sessionId}/ballots`, {
      person_id: ava.id,
      ranks: [{ option_id: "00000000-0000-0000-0000-000000000000", rank: 1 }],
    });
    expect(forced.status).toBe(403);

    // A stale ballot screen shows the server's own message: Ava is released from phone A
    // after its ballot loaded, then Done is refused.
    await expect(page.getByTestId("voting-as")).toHaveText("Ava");
    const released = await apiFromPhone(page, "DELETE", `/devices/me/people/${ava.id}`);
    expect(released.status).toBe(204);
    await poster(page, first).click();
    await page.getByRole("button", { name: "Done" }).click();
    // The refusal refreshes who this phone is: with nobody current it is back on "Who's watching?".
    await expect(page.locator('[data-screen="who"]')).toBeVisible();

    await phoneB.context().close();
  });

  test("a held person without the PIN goes to the host, whose Home inbox approves it", async ({
    page,
    browser,
    baseURL,
  }) => {
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    const night = seedNight({ movies: 2, openVoting: true });
    await joinAs(page, night, ["Ava"]);

    // Phone B asks for Ava, who is on the first phone. Two wrong PINs offer "Ask the host"
    // (ADR-0014's host override), and the phone waits for them.
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    await phoneB.goto("/who");
    await phoneB.getByRole("button", { name: /^Ava/ }).click();
    await expect(phoneB.locator('[data-screen="pin-enter"]')).toBeVisible();
    for (let i = 0; i < 2; i++) {
      await typePin(phoneB, "000000");
      await expect(phoneB.getByTestId("pin-message")).toContainText("tries left");
    }
    await phoneB.getByRole("button", { name: /Ask the host/ }).click();
    await expect(phoneB.locator('[data-screen="pending"]')).toBeVisible();

    // The host approves from the Home inbox in their own browser.
    const hostContext = await browser.newContext({ baseURL: baseURL as string });
    await signInAsHost(hostContext, night, baseURL as string);
    const host = await hostContext.newPage();
    await host.goto("/host");
    const row = host.locator('[data-inbox-kind="claim"]');
    await expect(row).toContainText("Ava", POLL);
    await row.getByRole("button", { name: /^Approve/ }).click();
    await expect(host.getByTestId("inbox-empty")).toBeVisible(POLL);

    // The waiting screen polls, so phone B moves on to the night as Ava by itself.
    await expect(phoneB).toHaveURL(new RegExp(`/s/${night.sessionId}$`), POLL);
    await expect(phoneB.getByTestId("voting-as")).toHaveText("Ava");

    await hostContext.close();
    await phoneB.context().close();
  });

  test("a night still being set up says so", async ({ page }) => {
    const night = seedNight();
    await joinAs(page, night, ["Mia"]);
    await page.goto(`/s/${night.sessionId}`);
    await expect(page.getByRole("heading", { name: "Almost ready" })).toBeVisible();
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "draft");
    await expectNoAxeViolations(page);
  });
});
