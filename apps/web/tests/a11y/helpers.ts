import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import * as OTPAuth from "otpauth";
import type { Page } from "@playwright/test";

/**
 * apps/web has no Nest/dotenv machinery of its own, and this tier deliberately stays fully
 * self-contained rather than importing across the apps/api package boundary -- same reasoning
 * and the same small, deliberate duplication as infra/scripts/totp-codes.ts's own loader,
 * just re-pointed at apps/web's location in the tree.
 */
function loadDatabaseUrlFromDotenv(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = resolve(import.meta.dirname, "../../../api/.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^DATABASE_URL=(.*)$/);
      if (match) return match[1]!.trim();
    }
  }
  throw new Error(`Could not find DATABASE_URL -- expected it in the environment or at ${envPath}`);
}

/**
 * Reads a seeded user's `mfaSecret` straight from Postgres and generates a currently-valid
 * TOTP code, the same technique `infra/scripts/totp-codes.ts` (`make totp`) uses -- codes are
 * live-generated here rather than hardcoded because the seeded secrets themselves rotate on
 * every `make demo-reset`/reseed, so any hardcoded code would go stale immediately.
 */
export async function getLiveTotpCode(email: string): Promise<string> {
  const client = new Client({ connectionString: loadDatabaseUrlFromDotenv() });
  await client.connect();
  try {
    const res = await client.query<{ mfaSecret: string | null }>('SELECT "mfaSecret" FROM users WHERE email = $1', [email]);
    const secret = res.rows[0]?.mfaSecret;
    if (!secret) throw new Error(`No mfaSecret found for ${email} -- has \`make demo\` (or \`make seed-mock\`) been run?`);
    return new OTPAuth.TOTP({ secret }).generate();
  } finally {
    await client.end();
  }
}

/**
 * Drives the real login form exactly as an operator would -- email/password, then the
 * mandatory TOTP step (see LoginPage.tsx; there is no "skip 2FA" path, by design) -- rather
 * than injecting a token directly, so this test tier also exercises LoginPage's own markup
 * on every run, not just the pages behind it.
 */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByLabel("Code").waitFor();
  const code = await getLiveTotpCode(email);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();

  await page.waitForURL("/");
}
