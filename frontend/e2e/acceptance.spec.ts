import { type Browser, type BrowserContext, type Page } from "@playwright/test";

import { pairAsTv, pinTieBreakSeed, signInWithMagicLink, signInWithPassword } from "./support/host";
import { MAILHOG_URL } from "./support/mail";
import {
  apiFromPhone,
  expectNoAxeViolations,
  joinAs,
  newPhoneLike,
  switchTo,
  typePin,
  vote,
} from "./support/phones";
import {
  addPhotos,
  type AlbumPhoto,
  HEIC_FIXTURE,
  JPEG_FIXTURE,
  PRESIGNED,
  recordApiAnswers,
} from "./support/photos";
import { expect, seedHousehold, test } from "./support/seed";

/**
 * Phase 1 acceptance (BUILD-PROMPT.md): "a Playwright run where 4 phones and a TV complete a night
 * with photos". One journey through the real UI, against the real API, Postgres, Redis, MailHog
 * and an S3 bucket. The API is called directly only where Phase 1 has no UI, each marked "API:".
 *
 * Cast: the host's phone (iPhone), a TV (1280x720), and four family phones:
 *   A  iPhone  Ava + Mia (shared: "Pass to next person")
 *   B  Pixel   Leo
 *   C  iPhone  Noah, who also asks for Leo (already on B): a pending claim the host approves
 *   D  Pixel   Zoe
 * and Pip, who has no phone: the host proxy-votes for them.
 *
 * Live, not polled: while `data-live="ready"` no screen polls (ADR-0004), so the TV's turnout and
 * the reveal are asserted within LIVE, under one 5s poll. Server-derived text throughout.
 */
const LIVE = { timeout: 4_000 };
/** The household's pending claims and the album refresh on a 10s poll by design. */
const POLL = { timeout: 15_000 };
/** revealed -> tonight settles 30s after the reveal (REVEAL_SETTLE), plus a poll and margin. */
const SETTLE = { timeout: 45_000 };
/** The tie-break seed the host's close pins (honoured only with ENVIRONMENT=test). */
const TEST_SEED = "424242";

const SHORTLIST = ["Paddington 2", "Spirited Away", "The Iron Giant", "Coco"] as const;
const [PADDINGTON, SPIRITED, IRON_GIANT, COCO] = SHORTLIST;
/** Added by the host on top of the seeded Ava, Leo and Mia. */
const MORE_PEOPLE = [
  { name: "Noah", avatar_emoji: "🦊", color: "#f97316" },
  { name: "Zoe", avatar_emoji: "🐙", color: "#a855f7" },
  { name: "Pip", avatar_emoji: "🐣", color: "#eab308" },
];
const EVERYONE = 6;

/**
 * 4 options, so ballot_size 3 and points 3/2/1 (ADR-0006). Spirited Away 3+2+3+2+3 = 13,
 * Paddington 1+3+1+2 = 7, The Iron Giant 1+2+3 = 6, Coco 2+1+3 = 6: no tie at the top.
 */
const BALLOTS: Record<string, readonly string[]> = {
  Ava: [SPIRITED, COCO, PADDINGTON],
  Mia: [PADDINGTON, SPIRITED, IRON_GIANT],
  Leo: [SPIRITED, IRON_GIANT, COCO],
  Noah: [COCO, SPIRITED, PADDINGTON],
  Zoe: [SPIRITED, PADDINGTON],
  Pip: [IRON_GIANT],
};

const liveRoot = (page: Page) => page.locator("[data-live]").first();
const tvTile = (tv: Page, name: string) =>
  tv.getByTestId("tv-tile").and(tv.locator(`[data-person="${name}"]`));

test.describe("Phase 1 acceptance", () => {
  test("4 phones and a TV complete a night with photos", async ({ browser, baseURL }) => {
    test.skip(!MAILHOG_URL, "the host signs in by the emailed link: needs MailHog (07-cicd.md)");
    test.setTimeout(240_000); // 7 browsers, a 30s settle, two photo uploads
    const origin = baseURL as string;
    const household = seedHousehold();
    const contexts: BrowserContext[] = [];
    const phone = async (device: "iPhone 13" | "Pixel 7") => {
      const { context, page } = await newPhoneLike(browser, device, origin);
      contexts.push(context);
      return page;
    };

    // --- The TV: the host resets their password by the emailed link on its browser (ADR-0014:
    // the link is "forgot password"), then pairs it from Settings → This browser.
    const tv = await newTv(browser, origin, contexts);
    const password = "acceptance night password";
    await signInWithMagicLink(tv, household.adminEmail, [], password);
    await expectNoAxeViolations(tv);
    await pairAsTv(tv);
    await expect(tv.getByTestId("tv-waiting")).toHaveText("Waiting for the host to start a night.");
    await expectNoAxeViolations(tv);

    // --- The host's phone: username + the new password, then the family and the night.
    const host = await phone("iPhone 13");
    await signInWithPassword(host, { adminUsername: household.adminUsername, password });
    await expectNoAxeViolations(host);
    for (const person of MORE_PEOPLE) {
      // API: adding people has no UI until Phase 2's admin screens (BUILD-PROMPT.md).
      const added = await apiFromPhone(host, "POST", "/admin/people", person);
      expect(added.status).toBe(201);
    }
    await host.getByLabel("Name it (optional)").fill("Acceptance night");
    await host.getByRole("button", { name: "Start movie night" }).click();
    await expect(host.getByTestId("night-code")).toHaveText(/^[2-9A-HJKMNP-Z]{6}$/);
    const hostCode = (await host.getByTestId("night-code").textContent())!.trim();
    await host.getByRole("link", { name: "Build the shortlist" }).click();
    await expect(host).toHaveURL(/\/host\/[0-9a-f-]{36}$/);
    const sessionId = host.url().split("/").at(-1)!;
    await expect(host.getByTestId("night-status")).toHaveText("Building the shortlist");

    // The TV follows the new night. It never saw the code, so the host types it there once.
    await expect(tv).toHaveURL(new RegExp(`/tv/${sessionId}$`), POLL);
    await expect(liveRoot(tv)).toHaveAttribute("data-live", "ready");
    await tv.getByLabel("Host: type tonight's code to show it here").fill(hostCode);
    await tv.getByRole("button", { name: "Show code" }).click();
    await expect(tv.getByTestId("tv-night-code")).toHaveText(hostCode);
    await expect(tv.getByTestId("tv-tile")).toHaveCount(EVERYONE);
    await expectNoAxeViolations(tv);

    // Shortlist: typed titles (TMDB search is never called, so no poster network in CI).
    for (const title of SHORTLIST) {
      await host.getByLabel("Movie title").fill(title);
      await host.getByRole("button", { name: "Add title" }).click();
      await expect(host.getByTestId("shortlist-item").filter({ hasText: title })).toBeVisible();
    }
    await expect(host.getByTestId("shortlist-count")).toHaveText("4 of 8");
    await expect(host.getByTestId("shortlist-item")).toHaveText(
      SHORTLIST.map((t) => new RegExp(t)),
    );
    await expect(tv.getByTestId("tv-headline")).toContainText("(4 so far)", LIVE);
    await expectNoAxeViolations(host);
    await host.getByRole("button", { name: "Open voting" }).click();
    await expect(host.getByTestId("night-status")).toHaveText("Voting");
    await expect(tv.getByTestId("tv-headline")).toHaveText(`0 of ${EVERYONE} voted`, LIVE);

    // --- Four phones scan the fridge QR (/j/{slug}) and type the code the TV shows.
    const tvCode = (await tv.getByTestId("tv-night-code").textContent())!.trim();
    const joinable = { slug: household.slug, nightCode: tvCode };

    const phoneA = await phone("iPhone 13");
    await phoneA.goto(`/j/${household.slug}`);
    await expect(phoneA.getByRole("heading", { name: "Join movie night" })).toBeVisible();
    await expectNoAxeViolations(phoneA);
    // Phone A is shared: Mia, then Ava (current, the last one picked).
    await joinAs(phoneA, joinable, ["Mia", "Ava"]);
    await expectNoAxeViolations(phoneA);

    const phoneB = await phone("Pixel 7");
    await joinAs(phoneB, joinable, ["Leo"]);
    const phoneD = await phone("Pixel 7");
    await joinAs(phoneD, joinable, ["Zoe"]);

    // Phone C is Noah's, and asks for Leo too. Leo is on phone B with a PIN phone C doesn't know:
    // after two wrong tries it asks the host instead (ADR-0014's host override).
    const phoneC = await phone("iPhone 13");
    await joinAs(phoneC, joinable, ["Noah"]);
    await phoneC.goto("/who");
    await phoneC.getByRole("button", { name: /^Leo/ }).click();
    for (const _ of [1, 2]) {
      await typePin(phoneC, "000000");
      await expect(phoneC.getByTestId("pin-message")).toContainText("tries left");
    }
    await phoneC.getByRole("button", { name: /Ask the host/ }).click();
    await expect(phoneC.locator('[data-screen="pending"]')).toBeVisible();

    // The host approves it from Home's "Needs you" inbox; the nav badge counted it.
    await host.goto("/host");
    const claim = host.locator('[data-inbox-kind="claim"]');
    await expect(claim).toHaveCount(1, POLL);
    await expect(claim).toContainText("Leo");
    await expect(host.getByTestId("nav-badge").first()).toHaveText("1");
    await expectNoAxeViolations(host);
    await claim.getByRole("button", { name: /^Approve/ }).click();
    await expect(host.getByTestId("inbox-empty")).toBeVisible(POLL);
    // The waiting screen polls, so phone C moves on to the night as Leo by itself.
    await expect(phoneC.getByTestId("voting-as")).toHaveText("Leo", POLL);

    // --- Everyone ranks posters; each ballot lights a TV tile through the stream.
    const voted = async (name: string, count: number) => {
      await expect(tvTile(tv, name)).toHaveAttribute("data-voted", "true", LIVE);
      await expect(tv.getByTestId("tv-headline")).toHaveText(`${count} of ${EVERYONE} voted`, LIVE);
    };

    await expect(phoneA).toHaveURL(new RegExp(`/s/${sessionId}$`));
    await expect(phoneA.getByTestId("night-screen")).toHaveAttribute("data-live", "ready");
    await expect(phoneA.getByRole("heading", { name: "Rank your favourites" })).toBeVisible();
    await expectNoAxeViolations(phoneA);
    await vote(phoneA, "Ava", BALLOTS.Ava!);
    await expectNoAxeViolations(phoneA);
    await voted("Ava", 1);
    await switchTo(phoneA, "Mia", { via: "pass" });
    await vote(phoneA, "Mia", BALLOTS.Mia!);
    await voted("Mia", 2);

    // One person on the phone: straight to the ballot.
    await expect(phoneB.getByTestId("night-screen")).toHaveAttribute("data-live", "ready");
    await vote(phoneB, "Leo", BALLOTS.Leo!);
    await voted("Leo", 3);

    // Phone C now holds Noah and the approved Leo (who already voted on phone B): it shows Leo's
    // picks, and passes to Noah with his PIN.
    await expect(phoneC.getByTestId("night-screen")).toHaveAttribute("data-live", "ready");
    await expect(phoneC.getByRole("heading", { name: "Thanks, Leo!" })).toBeVisible(LIVE);
    await switchTo(phoneC, "Noah", { via: "pass" });
    await vote(phoneC, "Noah", BALLOTS.Noah!);
    await voted("Noah", 4);

    await expect(phoneD.getByTestId("night-screen")).toHaveAttribute("data-live", "ready");
    await vote(phoneD, "Zoe", BALLOTS.Zoe!);
    await voted("Zoe", 5);

    // The host proxy-votes for Pip, who has no phone.
    await host.goto(`/host/${sessionId}`);
    await expect(host.getByTestId("night-status")).toHaveText("Voting");
    await host.getByRole("button", { name: "Add this browser to the family" }).click();
    await host.getByRole("button", { name: "Pip", exact: true }).click();
    for (const title of BALLOTS.Pip!) await host.getByRole("button", { name: title }).click();
    await expect(host.getByRole("button", { name: `${IRON_GIANT}, rank 1` })).toBeVisible();
    await host.getByRole("button", { name: "Save Pip's vote" }).click();
    await expect(host.getByTestId("proxy-saved")).toHaveText("Saved Pip's vote.");
    await voted("Pip", 6);
    await expect(host.getByTestId("voted-count")).toHaveText(`${EVERYONE} so far`, LIVE);
    await expectNoAxeViolations(host);
    await expectNoAxeViolations(tv);

    // --- The host closes (pinned tie-break seed); every screen shows the server's winner.
    await pinTieBreakSeed(host, TEST_SEED);
    await host.getByRole("button", { name: "Close voting" }).click();
    await expect(host.getByTestId("winner-title")).toHaveText(SPIRITED);
    await expect(tv.getByTestId("tv-winner")).toBeVisible(LIVE);
    await expect(tv.getByRole("heading", { name: SPIRITED })).toBeVisible();
    const phones = [phoneA, phoneB, phoneC, phoneD];
    for (const p of phones) {
      await expect(p.getByTestId("winner-title")).toHaveText(SPIRITED, LIVE);
      await expect(p.getByTestId("ballot-count")).toHaveText(`${EVERYONE} people voted`);
    }
    await expectNoAxeViolations(tv);
    await expectNoAxeViolations(phoneD);

    // --- The reveal settles into tonight: every phone opens the photo drop by itself.
    for (const p of phones) {
      await expect(p.getByTestId("night-screen")).toHaveAttribute("data-status", "tonight", SETTLE);
      await expect(p.getByRole("heading", { name: "Photos from tonight" })).toBeVisible();
    }
    await expect(phoneA.getByTestId("album-empty")).toBeVisible();
    await expectNoAxeViolations(phoneA);

    // Two phones add photos as their current person: phone A as Mia (the GPS JPEG), phone B as
    // Leo (the GPS HEIC).
    await expect(phoneA.getByTestId("voting-as")).toHaveText("Mia");
    await addPhotos(phoneA, [JPEG_FIXTURE]);
    await addPhotos(phoneB, [HEIC_FIXTURE]);

    // Another phone sees both in the album and reacts.
    await phoneC.goto(`/albums/${sessionId}`);
    const albumC = phoneC.getByTestId("album-grid").getByRole("listitem");
    await expect(albumC).toHaveCount(2);
    await expectNoAxeViolations(phoneC);
    await phoneC.getByRole("button", { name: "Open photo by Leo" }).click();
    const viewer = phoneC.getByTestId("photo-viewer");
    await expect(viewer.getByTestId("viewer-by")).toHaveText("Leo");
    await expect(viewer.getByRole("img", { name: "Photo by Leo" })).toHaveJSProperty(
      "complete",
      true,
    );
    const heart = viewer.getByTestId("react-❤️");
    await heart.click();
    await expect(heart).toHaveAttribute("aria-pressed", "true");
    await expect(heart).toHaveAccessibleName("React ❤️, 1");
    await expectNoAxeViolations(phoneC);
    await viewer.getByRole("button", { name: "Close" }).click();

    // The host hides Mia's photo. API: moderation has no UI until Phase 2's admin screens.
    const album = (await apiFromPhone(host, "GET", `/sessions/${sessionId}/photos`))
      .body as AlbumPhoto[];
    const mias = album.find((photo) => photo.person_name === "Mia")!;
    const hidden = await apiFromPhone(
      host,
      "POST",
      `/sessions/${sessionId}/photos/${mias.id}/hide`,
    );
    expect(hidden.status).toBe(204);

    // Every phone stops showing it on its next album refresh, with nothing reloaded.
    for (const p of phones) {
      // Exactly Leo's photo: a phone that hadn't refreshed since B's upload also shows one photo
      // (Mia's), so the count alone wouldn't prove the hide.
      const shown = p.getByRole("button", { name: /^Open photo by / });
      await expect
        .poll(
          () => shown.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
          POLL,
        )
        .toEqual(["Open photo by Leo"]);
    }

    // --- A browser that never joined gets no photo URL from anything it can reach.
    const stranger = await phone("Pixel 7");
    const answers = await recordApiAnswers(stranger.context());
    await stranger.goto(`/albums/${sessionId}`);
    await expect(
      stranger.getByText("Join a movie night on this phone to see your family's photos."),
    ).toBeVisible();
    const direct = await stranger.evaluate(async (id) => {
      const response = await fetch(`/api/v1/sessions/${id}/photos`);
      return { status: response.status, body: await response.text() };
    }, sessionId);
    expect(direct.status).toBe(401);
    expect(direct.body).not.toMatch(PRESIGNED);
    await stranger.goto(`/s/${sessionId}`);
    await expect(stranger.locator('[data-screen="landing"]')).toBeVisible();
    await expect(stranger.locator("img")).toHaveCount(0);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((answer) => PRESIGNED.test(answer))).toEqual([]);

    // --- History lists the night with its winner and turnout.
    await phoneD.goto("/history");
    const entry = phoneD.getByTestId("history-list").getByRole("listitem").first();
    await expect(entry.getByTestId("history-winner")).toHaveText(SPIRITED);
    await expect(entry.getByTestId("history-turnout")).toHaveText(`${EVERYONE} people voted`);
    await expectNoAxeViolations(phoneD);

    for (const context of contexts) await context.close();
  });
});

/** The living-room TV: a 1280x720 browser; the reveal lands at once instead of spinning. */
async function newTv(browser: Browser, baseURL: string, contexts: BrowserContext[]) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
    reducedMotion: "reduce",
  });
  contexts.push(context);
  return context.newPage();
}
