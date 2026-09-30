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
 * Reads the API's file-mail-outbox (see shared/infrastructure/mail/file-outbox.mailer.ts --
 * the default adapter, no real provider needed) for the most recent password-reset link sent
 * to `email`, and returns the full URL. Mirrors `apps/api/test/helpers.ts`'s
 * `readLatestMailTo`/`extractResetToken`, independently: this tier stays fully
 * self-contained from apps/api's own test helpers, same reasoning as
 * `loadDatabaseUrlFromDotenv` above.
 */
export function getLatestResetLink(email: string): string {
  const outboxPath = resolve(import.meta.dirname, "../../../api/storage/mail-outbox.jsonl");
  if (!existsSync(outboxPath)) {
    throw new Error(`No mail outbox found at ${outboxPath} -- has a password reset actually been requested yet?`);
  }
  const lines = readFileSync(outboxPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { to: string; text: string })
    .filter((entry) => entry.to === email);
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`No reset email found for ${email} in the outbox`);
  const match = last.text.match(/(http:\/\/\S+recuperar-senha\?token=\S+)/);
  if (!match) throw new Error(`Could not find a reset link in the email sent to ${email}`);
  return match[1]!;
}

/**
 * Same technique as `getLatestResetLink`, pointed at the "Enviar Convite Seguro" activation
 * link `SendInvitationHandler` emails instead of a password-reset link.
 */
export function getLatestInvitationLink(email: string): string {
  const outboxPath = resolve(import.meta.dirname, "../../../api/storage/mail-outbox.jsonl");
  if (!existsSync(outboxPath)) {
    throw new Error(`No mail outbox found at ${outboxPath} -- has an invitation actually been sent yet?`);
  }
  const lines = readFileSync(outboxPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { to: string; text: string })
    .filter((entry) => entry.to === email);
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`No invitation email found for ${email} in the outbox`);
  const match = last.text.match(/(http:\/\/\S+ativar-conta\?token=\S+)/);
  if (!match) throw new Error(`Could not find an activation link in the email sent to ${email}`);
  return match[1]!;
}

/**
 * Selects an option from a shadcn/Radix `Select`, the accessible-tree equivalent of
 * Playwright's own `locator.selectOption()` for a native `<select>` -- which doesn't work on
 * Radix's own combobox-button-plus-listbox-popover markup (every migrated form's `Select`,
 * starting with `UnitFormPage`). Opens the trigger via its accessible label, then clicks the
 * matching item in the popover listbox that opens.
 *
 * `option` mirrors the subset of `selectOption`'s own overloads these tests actually used: a
 * plain string is the option's *visible* text (Radix doesn't expose the underlying value to
 * the accessible tree, only what's rendered, so a call site passing an enum value like
 * `"LABORATORY"` has to become that option's pt-BR label instead), and `{ index }` picks the
 * nth item without depending on which one that is -- for the same "any eligible seed account
 * will do" reason the original `.selectOption({ index: 1 })` calls used it.
 */
export async function selectRadixOption(page: Page, labelText: string, option: string | { index: number }): Promise<void> {
  await page.getByLabel(labelText).click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor();
  if (typeof option === "string") {
    await listbox.getByRole("option", { name: option }).click();
  } else {
    await listbox.getByRole("option").nth(option.index).click();
  }
}

/**
 * Drives the real login form exactly as an operator would -- email/password, then the
 * mandatory TOTP step (see LoginPage.tsx; there is no "skip 2FA" path, by design) -- rather
 * than injecting a token directly, so this test tier also exercises LoginPage's own markup
 * on every run, not just the pages behind it. Labels are pt-BR (see i18n/locales/pt-BR.ts) --
 * LoginPage is the first page moved off hardcoded English, see docs/architecture.md.
 */
export async function login(page: Page, email: string, password: string, expectedUrl = "/"): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  // `exact: true`: PasswordField's show/hide toggle has its own aria-label ("Mostrar senha"),
  // which also contains "Senha" as a substring and would otherwise match too.
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();

  await page.getByLabel("Código").waitFor();
  const code = await getLiveTotpCode(email);
  await page.getByLabel("Código").fill(code);
  await page.getByRole("button", { name: "Verificar" }).click();

  // Defaults to "/" -- every existing caller's role (CLINIC_ADMIN/OPERATOR/PLATFORM_ADMIN)
  // lands there (see role-routes.ts). NURSING lands on "/enfermagem" instead, hence the
  // parameter rather than a hardcoded path.
  await page.waitForURL(expectedUrl);
}
