import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests only (07-cicd.md `unit` job). E2E lives in e2e/ and runs under Playwright.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
