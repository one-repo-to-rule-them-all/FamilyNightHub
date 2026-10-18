import { type Browser, type BrowserContext, type Page } from "@playwright/test";

import { expectNoAxeViolations, portalNav, signInAsHost } from "./support/host";
import { joinAs, newPhoneLike } from "./support/phones";
import { expect, seedNight, test } from "./support/seed";

/**
 * The admin screens (04-frontend.md "Admin") against the real API. One journey, as an admin
 * would do it on a laptop while a phone is in the room: add a person, merge a duplicate that a
 * phone already holds, rename and revoke that phone (it is bounced back to joining), rotate the
 * join link (the old one stops working), pick streaming services from tmdb-fake. A host-role
 * account gets the API's 403 as "Admins only". Runs once per run (pixel project only).
 */

async function laptop(browser: Browser, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
}

function row(page: Page, attribute: "data-person" | "data-device", value: string) {
  return page.locator(`tr[${attribute}="${value}"]`);
}

/** People's primary opens the Add dialog; the radio's input is hidden under its swatch. */
async function addPerson(
  page: Page,
  person: { name: string; emoji: string; color: string; guest?: boolean },
) {
  await page.getByTestId("primary-action").click();
  const form = page.getByTestId("add-person");
  await form.getByLabel("Name").fill(person.name);
  await form.getByLabel("Emoji avatar").fill(person.emoji);
  await form.getByRole("radio", { name: person.color }).check({ force: true });
  if (person.guest) await form.getByLabel(/^Guest/).check();
  await form.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByTestId("people-notice")).toHaveText(`Added ${person.name}.`);
  await expect(row(page, "data-person", person.name)).toBeVisible();
}

test("an admin manages people, devices and settings", async ({ browser, baseURL }) => {
  test.setTimeout(120_000); // two browsers, ten axe scans, one long journey
  const night = seedNight({ hostAccount: true });
  const adminContext = await laptop(browser, baseURL!);
  await signInAsHost(adminContext, night, baseURL!);
  const admin = await adminContext.newPage();
  const { context: phoneContext, page: phone } = await newPhoneLike(browser, "Pixel 7", baseURL!);

  // The portal's sidebar takes the admin from Home to People (owner portal §3).
  await admin.goto("/host");
  await expect(admin.locator('[data-screen="portal-home"]')).toBeVisible();
  await portalNav(admin, "People");
  await expect(admin).toHaveURL(/\/admin\/people$/);
  await expect(admin.locator('[data-screen="portal-people"]')).toBeVisible();
  const sidebar = admin.getByRole("navigation", { name: "Portal" });
  await expect(sidebar.getByRole("link", { name: "People" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const name of night.people) await expect(row(admin, "data-person", name)).toBeVisible();
  // Nobody has a PIN yet: People says so, and the PIN-requests section shows its empty state.
  await expect(admin.getByTestId("pin-requests-empty")).toBeVisible();
  await expect(admin.getByTestId("attention-line")).toContainText("haven't set a PIN yet");

  // Add a guest, then make them family.
  await addPerson(admin, { name: "Grandma", emoji: "👵", color: "Teal", guest: true });
  await expect(row(admin, "data-person", "Grandma")).toHaveAttribute("data-guest", "true");
  await admin.getByRole("button", { name: "Make Grandma a family member" }).click();
  await expect(admin.getByTestId("people-notice")).toHaveText("Grandma is family now.");
  await expect(row(admin, "data-person", "Grandma")).toHaveAttribute("data-guest", "false");

  // A name the household already has is the API's 409, shown as-is.
  await admin.getByTestId("primary-action").click();
  const addForm = admin.getByTestId("add-person");
  await addForm.getByLabel("Name").fill("grandma");
  await addForm.getByLabel("Emoji avatar").fill("👵");
  await addForm.getByRole("button", { name: "Add person" }).click();
  await expect(addForm.getByTestId("api-error-message")).toContainText("Grandma");
  await addForm.getByRole("button", { name: "Cancel" }).click();

  // Someone also added her as "Nana", and a phone has already picked Nana.
  await addPerson(admin, { name: "Nana", emoji: "🧶", color: "Amber" });
  await joinAs(phone, night, ["Nana"]);
  await expectNoAxeViolations(admin);

  // Merge Nana into Grandma: the confirm explains it, and the phone binding moves.
  await admin.getByLabel("Duplicate (will be hidden)").selectOption({ label: "🧶 Nana" });
  await admin.getByLabel("Keep").selectOption({ label: "👵 Grandma" });
  await admin.getByRole("button", { name: "Merge…" }).click();
  const merge = admin.getByTestId("merge-confirm");
  await expect(merge.getByRole("heading")).toHaveText("Merge Nana into Grandma?");
  await expect(merge).toContainText("ballots, ratings, photos, photo reactions and phone bindings");
  await expect(merge).toContainText("Nobody is ever deleted");
  await expectNoAxeViolations(admin);
  await merge.getByRole("button", { name: "Merge into Grandma" }).click();
  await expect(admin.getByTestId("people-notice")).toHaveText(
    "Merged Nana into Grandma. Moved 1 phone to Grandma.",
  );
  await expect(row(admin, "data-person", "Nana")).toHaveCount(0);
  // The phone now holds Grandma, and Nana is gone from its grid.
  await phone.reload();
  await expect(phone.getByRole("button", { name: /^Grandma/ })).toHaveAttribute(
    "data-binding",
    "mine",
  );
  await expect(phone.getByRole("button", { name: /^Nana/ })).toHaveCount(0);

  // Phones: the phone is listed with Grandma; rename it, then revoke it.
  await portalNav(admin, "Phones");
  await expect(admin).toHaveURL(/\/admin\/devices$/);
  const unnamed = row(admin, "data-device", "Unnamed phone");
  await expect(unnamed.locator('[data-col="people"]')).toContainText("Grandma");
  await expect(unnamed.locator('[data-col="last-seen"]')).not.toHaveText("Never");
  await admin.getByRole("button", { name: "Rename Unnamed phone" }).click();
  const rename = admin.getByRole("dialog", { name: "Rename Unnamed phone" });
  await rename.getByLabel("Label").fill("Kitchen phone");
  await rename.getByRole("button", { name: "Save", exact: true }).click();
  await expect(admin.getByTestId("devices-notice")).toHaveText("Renamed to Kitchen phone.");
  const kitchen = row(admin, "data-device", "Kitchen phone");
  await expect(kitchen).toHaveAttribute("data-revoked", "false");
  await expectNoAxeViolations(admin);

  await admin.getByRole("button", { name: "Revoke Kitchen phone" }).click();
  const revoke = admin.getByTestId("revoke-confirm");
  await expect(revoke).toContainText("This is final.");
  await expect(revoke).toContainText("rejoin with a night code");
  await expectNoAxeViolations(admin);
  await revoke.getByRole("button", { name: "Revoke for good" }).click();
  await expect(admin.getByTestId("devices-notice")).toHaveText("Revoked Kitchen phone.");
  await expect(kitchen).toHaveAttribute("data-revoked", "true");
  await expect(kitchen.locator('[data-col="status"]')).toContainText("Revoked");
  await expect(admin.getByRole("button", { name: "Revoke Kitchen phone" })).toHaveCount(0);
  // The revoked phone is bounced back to joining.
  await phone.reload();
  await expect(phone.locator('[data-screen="landing"]')).toBeVisible();

  // Settings: rotate the join link. The old one stops working; the new one lets a phone in.
  await portalNav(admin, "Settings");
  await expect(admin).toHaveURL(/\/admin\/settings$/);
  await expect(admin.getByTestId("join-url")).toHaveText(`${baseURL}/j/${night.slug}`);
  await admin.getByRole("button", { name: "Rotate join link…" }).click();
  const rotate = admin.getByTestId("rotate-confirm");
  await expect(rotate).toContainText("The printed fridge QR stops working right away");
  await expectNoAxeViolations(admin);
  await rotate.getByRole("button", { name: "Rotate link" }).click();
  await expect(admin.getByTestId("slug-rotated")).toBeVisible();
  await expect(admin.getByTestId("join-url")).not.toHaveText(`${baseURL}/j/${night.slug}`);
  const newUrl = (await admin.getByTestId("join-url").textContent()) ?? "";
  const newSlug = newUrl.split("/j/")[1];
  expect(newSlug).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);

  await phone.goto(`/j/${night.slug}`);
  await phone.getByLabel("Night code").fill(night.nightCode);
  await expect(phone.getByRole("alert").filter({ hasText: "code" })).toContainText(
    "That code didn't work",
  );
  await expect(phone).toHaveURL(new RegExp(`/j/${night.slug}$`));
  // Rejoining at the new link makes it a new device; Grandma is free to pick again.
  await joinAs(phone, { slug: newSlug, nightCode: night.nightCode }, ["Grandma"]);

  // Defaults and streaming services (from tmdb-fake, JustWatch + TMDB attribution shown).
  // Each settings group saves on its own; the edited group's Save is the one primary (#44).
  const nights = admin.locator("#nights");
  await nights.getByLabel("Age cap").selectOption("PG");
  await expect(admin.getByTestId("primary-action")).toHaveCount(1);
  await nights.getByTestId("primary-action").click();
  await expect(nights.getByTestId("save-status")).toHaveText("Saved");
  await expect(admin.getByTestId("primary-action")).toHaveCount(0);
  await expect(admin.getByTestId("justwatch-attribution")).toHaveText(
    "Streaming availability data provided by JustWatch.",
  );
  await expect(admin.getByTestId("tmdb-attribution")).toContainText(
    "This product uses the TMDB API but is not endorsed or certified by TMDB.",
  );
  await expect(admin.getByTestId("providers-count")).toHaveText("0 of 20 picked");
  await admin.getByRole("checkbox", { name: "Netflix" }).check();
  await admin.getByRole("checkbox", { name: "Disney Plus" }).check();
  await expect(admin.getByTestId("providers-count")).toHaveText("2 of 20 picked");
  const streaming = admin.locator("#streaming");
  await streaming.getByTestId("primary-action").click();
  await expect(streaming.getByTestId("save-status")).toHaveText("Saved");
  await expectNoAxeViolations(admin);

  // What the server holds survives a reload.
  await admin.reload();
  await expect(admin.getByTestId("providers-count")).toHaveText("2 of 20 picked");
  await expect(admin.getByRole("checkbox", { name: "Netflix" })).toBeChecked();
  await expect(admin.getByLabel("Age cap")).toHaveValue("PG");

  await phoneContext.close();
  await adminContext.close();
});

test("a host without admin rights gets 'Admins only' on every admin screen", async ({
  browser,
  baseURL,
}) => {
  test.slow(); // four screens, each a fresh navigation
  const night = seedNight({ hostAccount: true });
  const context = await laptop(browser, baseURL!);
  await context.addCookies([
    {
      name: "fnh_session",
      value: night.hostOnlyCookie!,
      url: baseURL!,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();

  // A host's portal nav is Home, History and Settings: no People, Phones or Library (AC-P2.2).
  await page.goto("/host");
  await expect(page.locator('[data-screen="portal-home"]')).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Portal" });
  await expect(nav.getByRole("link")).toHaveText(["Home", "History", "Settings"]);

  // The admin screens still answer the API's 403 as "Admins only" if opened by URL.
  for (const [screen, path] of [
    ["people", "people"],
    ["devices", "devices"],
    ["movies", "movies"],
  ]) {
    const answer = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/admin/${path}`) && r.request().method() === "GET",
    );
    await page.goto(`/admin/${screen}`);
    expect((await answer).status()).toBe(403);
    await expect(page.getByTestId("admin-forbidden")).toContainText("Admins only");
  }

  // Settings opens for a host with their own groups only: no household settings or QR toggle.
  await page.goto("/admin/settings");
  await expect(page.locator('[data-screen="portal-settings"]')).toBeVisible();
  await expect(page.locator("#account")).toBeVisible();
  await expect(page.locator("#joining")).toHaveCount(0);
  await expect(page.getByText(/Include tonight's code/)).toHaveCount(0);
  await expectNoAxeViolations(page);
  await context.close();
});

test("/admin without a session goes to sign-in", async ({ page }) => {
  await page.goto("/admin/people");
  await expect(page).toHaveURL(/\/login$/);
});
