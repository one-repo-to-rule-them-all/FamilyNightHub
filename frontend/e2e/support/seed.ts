import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { test as base } from "@playwright/test";

export type SeededNight = {
  slug: string;
  nightCode: string;
  householdName: string;
  adminEmail: string;
  people: string[];
  /** Signed `fnh_session` cookie value for the seeded admin (see seed_night.py). */
  hostSession: string;
};

const BACKEND = path.resolve(__dirname, "../../../backend");

/** A fresh household + open night through e2e/seed_night.py (same env as the API under test). */
export function seedNight(): SeededNight {
  const slug = `e2e-${randomBytes(5).toString("hex")}`;
  const result = spawnSync(
    "uv",
    ["run", "python", "../frontend/e2e/seed_night.py", "--slug", slug],
    {
      cwd: BACKEND,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    },
  );
  if (result.status !== 0) {
    throw new Error(`seed_night.py failed (${result.status}): ${result.stderr || result.error}`);
  }
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return JSON.parse(line) as SeededNight;
}

/** `night`: a household of its own per test, so tests never share state and need no cleanup. */
export const test = base.extend<{ night: SeededNight }>({
  // Playwright fixtures must destructure their dependencies; this one has none.
  night: async ({}, use) => {
    await use(seedNight());
  },
});

export { expect } from "@playwright/test";
