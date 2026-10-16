import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the real API (shape from Ctrl+Alt+Defeat playwright.config.ts @ dcbda7d).
 *
 * Playwright starts both servers: uvicorn from ../backend and Next (built + `next start` in CI,
 * `next dev` locally). The caller provides the API's env (DATABASE_URL as fnh_app, REDIS_URL,
 * SESSION_SECRET, DEVICE_TOKEN_PEPPER, ...) after the role bootstrap and `alembic upgrade head`;
 * each test seeds its own household through e2e/seed_night.py, so there is no shared fixture data.
 * See 07-cicd.md "Running E2E locally".
 *
 * Chromium only for now: the API's cookies are Secure, and Chromium is the engine that keeps
 * Secure cookies on http://localhost. Both projects are phone-sized (Pixel and iPhone viewports).
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3201);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8201);
const baseURL = `http://localhost:${WEB_PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  // 07-cicd.md: no retries into green. A flaky test gets quarantined with an issue instead.
  retries: 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "pixel", use: { ...devices["Pixel 7"] } },
    { name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: [
    {
      command: `uv run uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../backend",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      command: CI ? `npm run start -- --port ${WEB_PORT}` : `npm run dev -- --port ${WEB_PORT}`,
      url: baseURL,
      reuseExistingServer: !CI,
      timeout: 120_000,
      env: { API_INTERNAL_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
