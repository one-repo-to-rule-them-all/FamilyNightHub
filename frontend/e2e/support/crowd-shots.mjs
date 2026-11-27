/**
 * Screenshots one simulated crowd game (backend/scripts/simulate_crowd.py) on the TV, the host
 * panel and a phone. A DEV TOOL against a LOCAL stack, not a Playwright spec (the suite never
 * runs it):
 *
 *   node e2e/support/crowd-shots.mjs <sim.json> <outDir> <prefix> [--tv 1920x1080,1280x720]
 *        [--host] [--phone] [--phone-as "Grandma Esperanza"] [--base http://localhost:3290]
 *
 * `sim.json` is the simulator's one-line JSON output. Images are small JPEGs.
 */
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, devices } from "@playwright/test";

const [simFile, outDir, prefix, ...rest] = process.argv.slice(2);
const flag = (name) => rest.indexOf(name);
const value = (name, fallback) => (flag(name) >= 0 ? rest[flag(name) + 1] : fallback);
const base = value("--base", "http://localhost:3290");
const sim = JSON.parse(readFileSync(simFile, "utf8").trim().split(/\r?\n/).at(-1));
mkdirSync(outDir, { recursive: true });

const shot = async (page, name, fullPage = false) => {
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: path.join(outDir, `${prefix}-${name}.jpg`),
    type: "jpeg",
    quality: Number(value("--quality", "50")),
    fullPage,
  });
};

const hostCookie = {
  name: "fnh_session",
  value: sim.hostCookie,
  url: base,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
};

const browser = await chromium.launch();

async function hostContext(viewport) {
  const context = await browser.newContext({ baseURL: base, viewport });
  await context.addCookies([hostCookie]);
  return context;
}

// TV: pair this window as the TV (the real settings button), then open the game's screen.
const tvSizes = value("--tv", "").split(",").filter(Boolean);
if (tvSizes.length > 0) {
  const context = await hostContext({ width: 1280, height: 720 });
  const tv = await context.newPage();
  await tv.goto("/admin/settings");
  await tv.getByTestId("use-as-tv").click();
  await tv
    .getByTestId("use-as-tv-confirm")
    .getByRole("button", { name: "Yes, make it the TV" })
    .click();
  await tv.waitForURL(/\/tv/);
  await tv.goto(`/tv/games/${sim.gameId}`);
  await tv.locator('[data-live="ready"]').first().waitFor({ timeout: 20000 });
  for (const size of tvSizes) {
    const [w, h] = size.split("x").map(Number);
    await tv.setViewportSize({ width: w, height: h });
    await shot(tv, `tv-${size}`);
  }
  await context.close();
}

if (flag("--host") >= 0) {
  const context = await hostContext({ width: 1280, height: 900 });
  const host = await context.newPage();
  await host.goto(`/host/games/${sim.gameId}`);
  await host.getByTestId("host-game").waitFor({ timeout: 20000 });
  await shot(host, "host", true);
  await context.close();
}

if (flag("--phone") >= 0) {
  const name = value("--phone-as", sim.people[0]);
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: base });
  const page = await context.newPage();
  await page.goto(`/j/${sim.slug}`);
  await page.getByLabel("Night code").fill(sim.nightCode);
  await page.waitForURL(/\/who$/);
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await page.getByTestId("pin-input").fill(sim.pin);
  await page.waitForURL((u) => !u.pathname.endsWith("/who"));
  await page.goto("/games");
  await page.getByTestId("game-card").first().click();
  await page.getByTestId("game-screen").waitFor({ timeout: 20000 });
  await shot(page, "phone", true);
  await context.close();
}

await browser.close();
