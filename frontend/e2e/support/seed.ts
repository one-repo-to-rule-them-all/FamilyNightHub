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
  sessionId: string;
  /** Shortlist titles in display order (empty unless seeded with `movies`). */
  movies: string[];
  /** A signed `fnh_session` value for the household's admin (see seed_night.py). */
  hostCookie: string;
};

export type SeedOptions = {
  /** Typed titles to put on the shortlist (0-8). */
  movies?: number;
  /** Open voting after adding the shortlist (needs at least 2 movies). */
  openVoting?: boolean;
  /** Close voting and settle the reveal: the night is `tonight`, so photos are open. */
  tonight?: boolean;
};

const BACKEND = path.resolve(__dirname, "../../../backend");

/** A fresh household + night through e2e/seed_night.py (same env as the API under test). */
export function seedNight(options: SeedOptions = {}): SeededNight {
  const slug = `e2e-${randomBytes(5).toString("hex")}`;
  const args = ["run", "python", "../frontend/e2e/seed_night.py", "--slug", slug];
  if (options.movies) args.push("--movies", String(options.movies));
  if (options.openVoting) args.push("--open-voting");
  if (options.tonight) args.push("--tonight");
  const result = spawnSync("uv", args, {
    cwd: BACKEND,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
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
