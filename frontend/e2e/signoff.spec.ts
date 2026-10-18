import { type Browser, type Page } from "@playwright/test";

import { pairAsTv, portalNav, signInAsHost } from "./support/host";
import {
  apiFromPhone,
  expectNoAxeViolations,
  hostClosesNight,
  hostClosesVoting,
  joinAs,
  joinNight,
  newPhone,
  switchTo,
  typePin,
  vote,
} from "./support/phones";
import { addPhotos, JPEG_FIXTURE } from "./support/photos";
import { expect, type SeededNight, seedNight, test } from "./support/seed";

/**
 * Staging sign-off (#42): the ADR-0014 PIN flows and the owner portal's inbox end to end, on top
 * of the per-feature specs. The host's Start/Stop slideshow and the phone's Play slideshow are in
 * slideshow-control.spec.ts.
 */

const POLL = { timeout: 15_000 };
/** The reveal settles into `tonight` after REVEAL_SETTLE (30 s) plus a poll. */
const SETTLE = { timeout: 45_000 };
const API_URL = `http://localhost:${process.env.E2E_API_PORT ?? 8201}`;
const SCREENSHOTS = process.env.E2E_SCREENSHOTS ?? null;

/** A signed-in owner browser: a laptop or a phone-sized one. */
async function ownerBrowser(
  browser: Browser,
  baseURL: string,
  night: SeededNight,
  size: "laptop" | "phone",
  cookie: "admin" | "host" = "admin",
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    ...(size === "laptop"
      ? { viewport: { width: 1280, height: 800 } }
      : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
  });
  if (cookie === "admin") await signInAsHost(context, night, baseURL);
  else {
    await context.addCookies([
      {
        name: "fnh_session",
        value: night.hostOnlyCookie!,
        url: baseURL,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
  }
  return context.newPage();
}

/** On /who, taps someone another phone holds and types wrong PINs `times` times. */
async function wrongPins(phone: Page, name: string, times: number) {
  await phone.goto("/who");
  await phone.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(phone.locator('[data-screen="pin-enter"]')).toBeVisible();
  for (let i = 1; i <= times; i++) {
    await typePin(phone, "000000");
    if (i < 5) await expect(phone.getByTestId("pin-message")).toContainText(`${5 - i} tr`);
  }
}

/** Two wrong PINs, then "Ask the host": a pending claim (S4). */
async function askHostFor(phone: Page, name: string) {
  await wrongPins(phone, name, 2);
  await phone.getByRole("button", { name: /Ask the host/ }).click();
  await expect(phone.locator('[data-screen="pending"]')).toBeVisible();
}

/** "Forgot PIN?" on the enter sheet: an open reset request, no lock (AC-5.5). */
async function forgotPinFor(phone: Page, name: string) {
  await phone.goto("/who");
  await phone.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await phone.getByRole("button", { name: "Forgot PIN?" }).click();
  await expect(phone.locator('[data-screen="reset-pending"]')).toBeVisible();
  // It stays waiting through the next poll: the pre-request tile is never read as an answer.
  await phone.waitForResponse(
    (r) => r.url().endsWith("/api/v1/people") && r.request().method() === "GET",
  );
  await expect(phone.locator('[data-screen="reset-pending"]')).toBeVisible();
}

test.describe("sign-off", () => {
  test("a new guest: join, profile, PIN, vote, reveal, photo, rate", async ({ page, request }) => {
    test.setTimeout(150_000); // includes the 30 s reveal settle
    const night = seedNight({ movies: 3, openVoting: true });
    const [, spirited] = night.movies;

    // S7: "I'm new here" makes a guest profile, then S3c picks their PIN.
    await joinNight(page, night);
    await page.getByRole("button", { name: "I'm new here" }).click();
    await expect(page.locator('[data-screen="new-guest"]')).toBeVisible();
    const next = page.getByRole("button", { name: "Next", exact: true });
    await expect(next).toBeDisabled();
    await page.getByLabel("Name").fill("Grandpa Joe");
    await page
      .getByRole("button", { name: /^Picture / })
      .first()
      .click();
    await expectNoAxeViolations(page);
    await next.click();
    await expect(page.locator('[data-screen="pin-create"]')).toBeVisible();
    await typePin(page, "314159");
    await expect(page.getByTestId("pin-sheet")).toContainText("Type it again");
    await typePin(page, "314159");

    // Straight onto the ballot as the new guest.
    await expect(page).toHaveURL(new RegExp(`/s/${night.sessionId}$`));
    await vote(page, "Grandpa Joe", [spirited]);

    // The host closes; the phone shows the server's winner, then settles into tonight.
    const closed = await hostClosesVoting(request, night);
    const winner = closed.options.find((o) => o.id === closed.result?.winner_option_id)!.title;
    await expect(page.getByTestId("winner-title")).toHaveText(winner, POLL);
    await expect(page.getByTestId("night-screen")).toHaveAttribute(
      "data-status",
      "tonight",
      SETTLE,
    );

    // Photos as the current person.
    await addPhotos(page, [JPEG_FIXTURE]);
    await expect(page.getByRole("button", { name: "Open photo by Grandpa Joe" })).toBeVisible(POLL);

    // After the night the guest rates it.
    await hostClosesNight(request, night);
    await page.goto(`/s/${night.sessionId}`);
    await expect(page.getByTestId("night-screen")).toHaveAttribute("data-status", "closed");
    const panel = page.getByTestId("rating-panel");
    await panel.getByRole("radio", { name: "5 stars" }).click();
    await expect(panel.getByTestId("family-average")).toHaveText(
      "Family average: 5.0 from 1 rating",
    );

    // Their profile lists the night.
    await page.goto("/me");
    await expect(page.getByRole("heading", { name: /Grandpa Joe/ }).first()).toBeVisible();
  });

  test("a shared-phone switch needs that person's PIN; a wrong one changes nothing", async ({
    page,
  }) => {
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    const night = seedNight({ movies: 3, openVoting: true });
    await joinAs(page, night, ["Mia", "Ava"]);
    await expect(page.getByTestId("voting-as")).toHaveText("Ava");

    await page.getByTestId("current-chip").click();
    await page.getByTestId("switch-sheet").getByRole("button", { name: /^Mia/ }).click();
    await expect(page.locator('[data-screen="pin-switch"]')).toBeVisible();
    await expect(page.getByTestId("still-current")).toContainText("Ava");
    await typePin(page, "000000");
    await expect(page.getByTestId("pin-message")).toContainText("4 tries left");
    await page.getByTestId("pin-sheet").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Back to Ava" }).last().click();

    // Still Ava, on screen and on the server (AC-8.4).
    await expect(page.getByTestId("voting-as")).toHaveText("Ava");
    const people = (await apiFromPhone(page, "GET", "/people")).body as {
      name: string;
      current: boolean;
    }[];
    expect(people.filter((p) => p.current).map((p) => p.name)).toEqual(["Ava"]);

    // The right PIN switches.
    await switchTo(page, "Mia");
    await expect(page.getByTestId("voting-as")).toHaveText("Mia");
  });

  test("5 wrong PINs lock; Forgot PIN reaches the admin's inbox and People; a reset works", async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const night = seedNight({ movies: 3, openVoting: true });
    await joinAs(page, night, ["Ava"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);

    await wrongPins(phoneB, "Ava", 5);
    await expect(phoneB.locator('[data-screen="locked"]')).toBeVisible();
    await expectNoAxeViolations(phoneB);
    await phoneB.getByRole("button", { name: "Ask the family admin to reset your PIN" }).click();
    await expect(phoneB.locator('[data-screen="reset-pending"]')).toBeVisible();
    // Ava's own phone keeps working while she is locked.
    await page.reload();
    await expect(page.getByTestId("voting-as")).toHaveText("Ava");

    const admin = await ownerBrowser(browser, baseURL!, night, "laptop");
    await admin.goto("/host");
    const row = admin.locator('[data-inbox-kind="pin-reset"]');
    await expect(row).toContainText("Ava forgot their PIN", POLL);
    await expect(row).toContainText("Locked");
    const nav = admin.getByRole("navigation", { name: "Portal" });
    await expect(nav.getByRole("link", { name: /Home/ }).getByTestId("nav-badge")).toHaveText("1");
    await expect(nav.getByRole("link", { name: /People/ }).getByTestId("nav-badge")).toHaveText(
      "1",
    );

    // People lists the request and shows Ava as locked.
    await portalNav(admin, "People");
    await expect(admin.getByTestId("pin-requests")).toContainText("Ava");
    await expect(admin.locator('tr[data-person="Ava"]')).toHaveAttribute("data-status", "locked");
    await expect(admin.getByTestId("attention-line")).toContainText("Ava is locked");

    // Reset from Home's inbox, behind its confirm.
    await portalNav(admin, "Home");
    await admin.getByRole("button", { name: "Reset PIN for Ava" }).click();
    await admin.getByTestId("reset-pin-confirm").getByRole("button", { name: "Reset PIN" }).click();
    await expect(admin.getByTestId("inbox-empty")).toBeVisible(POLL);
    await expect(nav.getByTestId("nav-badge")).toHaveCount(0);

    // The phone that asked chooses a new PIN by itself, and is Ava now.
    await expect(phoneB.locator('[data-screen="pin-create"]')).toBeVisible(POLL);
    await typePin(phoneB, "777123");
    await expect(phoneB.getByTestId("pin-sheet")).toContainText("Type it again");
    await typePin(phoneB, "777123");
    await expect(phoneB.getByTestId("voting-as")).toHaveText("Ava", POLL);

    await admin.context().close();
    await phoneB.context().close();
  });

  test("a host account never sees or approves PIN resets", async ({ page, browser, baseURL }) => {
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    const night = seedNight({ movies: 3, openVoting: true, hostAccount: true });
    await joinAs(page, night, ["Ava"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    await forgotPinFor(phoneB, "Ava");

    // The admin sees the open request; the host's Home does not, and has no People nav.
    const admin = await ownerBrowser(browser, baseURL!, night, "laptop");
    await admin.goto("/host");
    await expect(admin.locator('[data-inbox-kind="pin-reset"]')).toHaveCount(1, POLL);

    const host = await ownerBrowser(browser, baseURL!, night, "laptop", "host");
    await host.goto("/host");
    await expect(host.getByTestId("inbox-empty")).toBeVisible(POLL);
    await expect(host.locator('[data-inbox-kind="pin-reset"]')).toHaveCount(0);
    await expect(
      host.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /People/ }),
    ).toHaveCount(0);

    // And the API refuses them outright.
    const asHost = { Cookie: `fnh_session=${night.hostOnlyCookie}; fnh_csrf=c`, "X-FNH-CSRF": "c" };
    const asAdmin = { Cookie: `fnh_session=${night.hostCookie}` };
    const list = await host.request.get(`${API_URL}/api/v1/admin/people/pin-resets`, {
      headers: asHost,
    });
    expect(list.status()).toBe(403);
    const resets = (await (
      await admin.request.get(`${API_URL}/api/v1/admin/people/pin-resets`, { headers: asAdmin })
    ).json()) as { id: string }[];
    const approve = await host.request.post(
      `${API_URL}/api/v1/admin/people/pin-resets/${resets[0].id}/approve`,
      { headers: asHost },
    );
    expect(approve.status()).toBe(403);
    await expect(phoneB.locator('[data-screen="reset-pending"]')).toBeVisible();

    await host.context().close();
    await admin.context().close();
    await phoneB.context().close();
  });

  test("the TV QR carries the night code only while the admin's setting is on", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const night = seedNight();
    const tvContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
    await signInAsHost(tvContext, night, baseURL!);
    const tv = await tvContext.newPage();
    await pairAsTv(tv);
    await expect(tv).toHaveURL(new RegExp(`/tv/${night.sessionId}$`), POLL);
    await tv.getByLabel("Host: type tonight's code to show it here").fill(night.nightCode);
    await tv.getByRole("button", { name: "Show code" }).click();
    const qr = tv.getByRole("img", { name: /^QR code for / });
    // Off by default (AC-11.3): the QR is the plain join link.
    await expect(qr).toHaveAttribute("aria-label", `QR code for ${baseURL}/j/${night.slug}`);

    const admin = await ownerBrowser(browser, baseURL!, night, "laptop");
    await admin.goto("/admin/settings");
    const toggle = admin.getByRole("switch", { name: /Include tonight's code/ });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(qr).toHaveAttribute(
      "aria-label",
      `QR code for ${baseURL}/j/${night.slug}?code=${night.nightCode}`,
      POLL,
    );

    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect(qr).toHaveAttribute("aria-label", `QR code for ${baseURL}/j/${night.slug}`, POLL);

    await admin.context().close();
    await tvContext.close();
  });

  test("a held person with no PIN waits for the host; only a real rejection says no", async ({
    page,
    browser,
    request,
  }) => {
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    const night = seedNight({ movies: 3, openVoting: true });
    const admin = { Cookie: `fnh_session=${night.hostCookie}; fnh_csrf=c`, "X-FNH-CSRF": "c" };

    // Staging (#42): Ava is held by phone A but has no PIN (here: her PIN was reset, as a pre-PIN
    // binding would be).
    await joinAs(page, night, ["Ava"]);
    const people = (await apiFromPhone(page, "GET", "/people")).body as {
      id: string;
      name: string;
    }[];
    const ava = people.find((p) => p.name === "Ava")!;
    expect(
      (await apiFromPhone(page, "POST", `/devices/me/people/${ava.id}/forgot-pin`)).status,
    ).toBe(202);
    const [reset] = (await (
      await request.get(`${API_URL}/api/v1/admin/people/pin-resets`, { headers: admin })
    ).json()) as { id: string }[];
    expect(
      (
        await request.post(`${API_URL}/api/v1/admin/people/pin-resets/${reset.id}/approve`, {
          headers: admin,
        })
      ).status(),
    ).toBe(200);

    // Phone B taps her: the claim goes to the host and the phone waits, through the next polls.
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    await phoneB.goto("/who");
    const tile = phoneB.getByRole("button", { name: /^Ava/ });
    await expect(tile).toHaveAttribute("data-action", "ask-host");
    await tile.click();
    await expect(phoneB.locator('[data-screen="pending"]')).toBeVisible();
    for (let i = 0; i < 2; i++) {
      await phoneB.waitForResponse(
        (r) => r.url().endsWith("/api/v1/people") && r.request().method() === "GET",
      );
      await expect(phoneB.locator('[data-screen="pending"]')).toBeVisible();
    }
    await expect(phoneB.getByText(/The host said no/)).toHaveCount(0);

    // The claim is really there; when the host rejects it, the phone says so.
    const claims = (await (
      await request.get(`${API_URL}/api/v1/devices/claims`, { headers: admin })
    ).json()) as { device_id: string; person_name: string; person_id: string }[];
    const claim = claims.find((c) => c.person_name === "Ava")!;
    expect(claim).toBeTruthy();
    expect(
      (
        await request.post(
          `${API_URL}/api/v1/devices/${claim.device_id}/people/${claim.person_id}/reject`,
          { headers: admin },
        )
      ).status(),
    ).toBeLessThan(300);
    await expect(phoneB.getByText(/The host said no for/)).toBeVisible(POLL);
    await expect(phoneB.locator('[data-screen="who"]')).toBeVisible();

    await phoneB.context().close();
  });

  test("Here tonight shows a phone that joined but hasn't voted", async ({ page, browser }) => {
    test.slow(); // several phones; every PIN claim or switch is an argon2id check (ADR-0014)
    const night = seedNight({ movies: 3, openVoting: true });
    await joinAs(page, night, ["Ava"]);
    const phoneB = await newPhone(browser);
    await joinAs(phoneB, night, ["Leo"]);
    await expect(phoneB.getByTestId("voting-as")).toHaveText("Leo");

    await vote(page, "Ava", [night.movies[0]]);
    const here = page.getByTestId("here-tonight");
    await expect(here.getByRole("listitem").filter({ hasText: "Leo" })).toBeVisible(POLL);
    await expect(here.getByRole("listitem").filter({ hasText: "Ava" })).toContainText("voted");
    await expect(here.getByRole("listitem").filter({ hasText: "Leo" })).not.toContainText("voted");
    await expect(page.getByText("2 here · 1 voted")).toBeVisible(POLL);

    await phoneB.context().close();
  });

  for (const size of ["phone", "laptop"] as const) {
    test(`portal nav, inbox and badges (${size})`, async ({ page, browser, baseURL }) => {
      test.setTimeout(90_000);
      const night = seedNight({ movies: 3, openVoting: true });
      // Ava on phone A; phone B (Leo) asks the host for Ava; phone C asks to reset Leo's PIN.
      await joinAs(page, night, ["Ava"]);
      const phoneB = await newPhone(browser);
      await joinAs(phoneB, night, ["Leo"]);
      await askHostFor(phoneB, "Ava");
      const phoneC = await newPhone(browser);
      await joinAs(phoneC, night, ["Mia"]);
      await forgotPinFor(phoneC, "Leo");

      const admin = await ownerBrowser(browser, baseURL!, night, size);
      await admin.goto("/host");
      await expect(admin.locator('[data-screen="portal-home"]')).toBeVisible();
      // Priority: the PIN request above the claim (§5 P2).
      const rows = admin.locator("[data-inbox-kind]");
      await expect(rows).toHaveCount(2, POLL);
      await expect(rows.nth(0)).toHaveAttribute("data-inbox-kind", "pin-reset");
      await expect(rows.nth(1)).toHaveAttribute("data-inbox-kind", "claim");

      // The Home badge counts the inbox rows (AC-P2.7); People counts the PIN request.
      const nav = admin.getByRole("navigation", { name: "Portal" });
      const homeBadge = nav.getByRole("link", { name: /Home/ }).getByTestId("nav-badge");
      await expect(homeBadge).toHaveText("2");
      await expect(homeBadge).toHaveAccessibleName("2 things need you");
      await expect(nav.getByRole("link", { name: /People/ }).getByTestId("nav-badge")).toHaveText(
        "1",
      );
      await expectNoAxeViolations(admin);
      if (SCREENSHOTS) {
        await admin.screenshot({ path: `${SCREENSHOTS}/portal-home-${size}.png`, fullPage: true });
      }

      if (size === "phone") {
        await expect(nav.getByRole("link")).toHaveText([/Home/, /People/, /Library/, /History/]);
        await nav.getByRole("button", { name: "More" }).click();
        const more = admin.getByTestId("portal-more");
        await expect(more.getByRole("link")).toHaveText(["Phones", "Settings"]);
        await expect(more.getByTestId("sign-out")).toBeVisible();
        await nav.getByRole("button", { name: "More" }).click();
      } else {
        await expect(nav.getByRole("link")).toHaveText([
          /Home/,
          /People/,
          "Phones",
          "Library",
          "History",
          "Settings",
        ]);
      }

      // Approve the claim from the inbox: phone B becomes Ava, the badge drops to 1.
      await rows
        .nth(1)
        .getByRole("button", { name: /^Approve/ })
        .click();
      await expect(rows).toHaveCount(1, POLL);
      await expect(homeBadge).toHaveText("1", POLL);
      await expect(phoneB.getByTestId("voting-as")).toHaveText("Ava", POLL);

      // "See profile"-style link: the People badge leads to the open request.
      await portalNav(admin, "People");
      await expect(admin.getByTestId("pin-requests")).toContainText("Leo");
      if (SCREENSHOTS) {
        await admin.screenshot({
          path: `${SCREENSHOTS}/portal-people-${size}.png`,
          fullPage: true,
        });
      }

      await admin.context().close();
      await phoneB.context().close();
      await phoneC.context().close();
    });
  }
});
