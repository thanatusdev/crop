import { defineConfig } from "@playwright/test";
import path from "node:path";

/**
 * Accessibility test tier for apps/web -- deliberately local/on-demand only, NOT wired into
 * `.github/workflows/ci.yml`. Running it end-to-end needs the full no-hardware demo stack
 * (Postgres, Redis, mock PiKVM, the API, and Vite) rather than the lighter unit/e2e setups
 * the rest of the repo's CI already runs, and axe-core scans are inherently a point-in-time
 * check of rendered DOM, not something worth gating every commit on. See README.md's
 * Accessibility section and docs/architecture.md for why this exists and how to run it.
 *
 * `webServer` below runs `make demo` from the repo root: if a demo stack is already running
 * (the same one used for every manual live-browser check throughout this project), Playwright
 * reuses it as-is (`reuseExistingServer`); otherwise it starts one from scratch, exactly the
 * same command a developer would run by hand.
 */
export default defineConfig({
  testDir: "./tests/a11y",
  timeout: 60_000,
  fullyParallel: false, // shares one demo stack / one set of seeded accounts across all specs
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "make demo",
    cwd: path.resolve(import.meta.dirname, "../.."),
    url: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
