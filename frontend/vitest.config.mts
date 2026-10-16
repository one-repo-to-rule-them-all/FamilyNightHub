import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests only (07-cicd.md `unit` job). E2E lives in e2e/ and runs under Playwright.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "text"],
      // Pure logic is gated at 100% (as the backend's domain package is): the ballot reducer and
      // the album's URL reuse, the live-stream state machine (ADR-0004) and the rating helpers. The upload queue
      // is gated on lines (its retry/backoff paths).
      thresholds: {
        "src/lib/ballot.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/live.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/rating.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/bulk-titles.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/photos/album.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/photos/queue.ts": { lines: 100 },
      },
    },
  },
});
