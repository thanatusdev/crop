import { execSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login } from "./helpers.js";

/**
 * Scans every distinct page in apps/web with axe-core, against the real seeded demo accounts
 * (see README.md's Seeded demo accounts / `make demo`) -- not a mocked DOM fixture, the actual
 * rendered app, logged in through the real (mandatory-2FA) auth flow. This is the automated
 * check that a prior verification pass found never existed: the a11y fixes made earlier in
 * this project's history (landmarks, labels, focus-visible, live regions -- see
 * docs/architecture.md) were previously provable only by manual/AI-driven Playwright sessions
 * during development, never by a repeatable test a future regression would actually fail.
 *
 * Deliberately local/on-demand only (`pnpm --filter @crop/web test:a11y`), not part of
 * `.github/workflows/ci.yml` -- see playwright.config.ts's own docstring for why.
 */

const ADMIN = { email: "admin@alpha.crop.health", password: "SenhaForte123!" };
const OPERATOR = { email: "operator@alpha.crop.health", password: "SenhaForte123!" };
const SUPERADMIN = { email: "superadmin@crop.health", password: "SenhaForte123!" };

test.beforeAll(() => {
  // Idempotent by design (infra/seeds/bootstrap-superadmin.ts) -- ensures the superadmin
  // fixture exists even on a freshly-seeded demo stack, without requiring the developer to
  // have already run `make bootstrap-superadmin` by hand first.
  execSync("pnpm bootstrap:superadmin", {
    cwd: path.resolve(import.meta.dirname, "../../../.."),
    stdio: "inherit",
  });
});

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("Login page", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("heading", { name: "CROP" }).waitFor();
  await expectNoViolations(page);
});

test("Dashboard page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole("heading", { name: "Equipment" }).waitFor();
  await expectNoViolations(page);
});

test("Audit page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole("button", { name: "Audit log" }).click();
  await page.waitForURL("/audit");
  await page.getByRole("heading", { name: "Audit log" }).waitFor();
  await expectNoViolations(page);
});

test("Admin users page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole("button", { name: "Manage users" }).click();
  await page.waitForURL("/admin/users");
  await page.getByRole("heading", { name: "Users" }).waitFor();
  await expectNoViolations(page);
});

test("Admin equipment page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole("button", { name: "Manage equipment" }).click();
  await page.waitForURL("/admin/equipment");
  await page.getByRole("heading", { name: "Equipment", exact: true }).waitFor();
  await expectNoViolations(page);
});

test("Superadmin tenants page", async ({ page }) => {
  await login(page, SUPERADMIN.email, SUPERADMIN.password);
  await page.getByRole("button", { name: "Manage tenants" }).click();
  await page.waitForURL("/superadmin/tenants");
  await page.getByRole("heading", { name: "Tenants" }).waitFor();
  await expectNoViolations(page);
});

test("Session page and replay page", async ({ page }) => {
  await login(page, OPERATOR.email, OPERATOR.password);

  // Depends on PiKvmHealthPoller having already confirmed the mock PiKVM is reachable and
  // flipped equipment to ONLINE (happens shortly after `make demo` starts) -- generous
  // timeout, not a fixed sleep, since exactly how long that takes depends on when the demo
  // stack itself came up relative to this test run. Accepts either "Start session" (no
  // active session yet) or "Rejoin session" (one already left open by an earlier run of this
  // same spec, e.g. after a prior failure before its own cleanup step ran) -- either way,
  // clicking it lands on the same SessionPage this test needs to scan.
  const sessionButton = page.locator("button:not([disabled])").filter({ hasText: /^(Start session|Rejoin session)$/ }).first();
  await expect(sessionButton).toBeVisible({ timeout: 30_000 });
  await sessionButton.click();
  await page.waitForURL(/\/sessions\/[^/]+$/);
  await page.getByRole("button", { name: "End session" }).waitFor();
  await expectNoViolations(page);

  await page.getByRole("button", { name: "View replay" }).click();
  await page.waitForURL(/\/sessions\/[^/]+\/replay$/);
  // Specifically this page's own heading (not SessionPage's, which also has a level-1
  // heading and can still be briefly mounted after `waitForURL` resolves -- a client-side
  // route transition changes the URL before the outgoing component actually unmounts).
  await page.getByRole("heading", { name: /session replay$/ }).waitFor();
  await expectNoViolations(page);

  // Cleanup: free the equipment for any later run of this same spec (or a manual demo
  // session) rather than leaving a session open indefinitely.
  await page.goBack();
  await page.getByRole("button", { name: "End session" }).click();
});
