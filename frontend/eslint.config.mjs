// ESLint (next config), shape from Ctrl+Alt+Defeat eslint.config.mjs @ dcbda7d.
//
// eslint, eslint-config-next and the TypeScript 5 that typescript-eslint parses with are installed in
// tools/eslint/ (the app runs TypeScript 7, which typescript-eslint does not support), so the
// plugins are resolved from there. Run it with `npm run lint`.
import { createRequire } from "node:module";

const require = createRequire(new URL("./tools/eslint/package.json", import.meta.url));
const { defineConfig, globalIgnores } = require("eslint/config");
const nextVitals = require("eslint-config-next/core-web-vitals");
const nextTs = require("eslint-config-next/typescript");

// The 07-cicd.md rule: no fixed waits in tests. Wait on server-derived state instead.
const noFixedWaits = [
  {
    selector: "CallExpression[callee.property.name='waitForTimeout']",
    message: "No waitForTimeout: assert on server-derived text (07-cicd.md determinism rules).",
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message: "No sleeps in tests: use expect.poll / web-first assertions or fake timers.",
  },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
  {
    files: ["e2e/**/*.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: { "no-restricted-syntax": ["error", ...noFixedWaits] },
  },
  {
    // Playwright fixtures receive a `use` callback, which is not React's `use` hook.
    files: ["e2e/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "tools/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    "src/types/api.gen.ts",
  ]),
]);
