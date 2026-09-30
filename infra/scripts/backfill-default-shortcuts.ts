/**
 * Seeds `DEFAULT_MESSAGE_SHORTCUTS` into every `CLINIC` tenant that doesn't already have
 * them -- the one-time gap `SeedDefaultShortcutsHandler` (reacting to `TenantCreatedEvent`)
 * cannot itself close: that handler only ever fires for a clinic created *after* it started
 * listening, and the `exam_chat_and_shortcuts` migration's own backfill only covers clinics
 * that existed *at migration-apply time* -- neither covers a clinic like this repo's own
 * seeded "Clinica Alpha"/"Clinica Beta", created by `infra/seeds/seed.ts` (via
 * `CreateTenantCommand`) before either of those two mechanisms existed. Idempotent by the
 * same `(tenantId, code)` unique index every other seeding path relies on -- safe to run as
 * many times as needed, including after a fresh `make demo-reset`.
 *
 * Usage: pnpm --filter @crop/api exec tsx ../../infra/scripts/backfill-default-shortcuts.ts
 * (wired up as `make backfill-shortcuts` -- see the Makefile).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_MESSAGE_SHORTCUTS } from "@crop/shared";

/** Same minimal, dependency-free .env loader `totp-codes.ts` already uses -- this isn't a
 * Nest app, so it has no other way to read `DATABASE_URL`. */
function loadDatabaseUrlFromDotenv(): void {
  if (process.env.DATABASE_URL) return;
  const envPath = resolve(import.meta.dirname, "../../apps/api/.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^DATABASE_URL=(.*)$/);
    if (match) {
      process.env.DATABASE_URL = match[1]!.trim();
      return;
    }
  }
}

async function main(): Promise<void> {
  loadDatabaseUrlFromDotenv();
  const prisma = new PrismaClient();

  const clinics = await prisma.tenant.findMany({ where: { type: "CLINIC" }, orderBy: { name: "asc" } });
  if (clinics.length === 0) {
    console.log("No CLINIC tenants found -- run `make seed` (or `pnpm db:seed`) first.");
    await prisma.$disconnect();
    return;
  }

  for (const clinic of clinics) {
    const result = await prisma.messageShortcut.createMany({
      data: DEFAULT_MESSAGE_SHORTCUTS.map((shortcut) => ({ tenantId: clinic.id, ...shortcut })),
      skipDuplicates: true,
    });
    console.log(`${clinic.name}: ${result.count} shortcut(s) created (${DEFAULT_MESSAGE_SHORTCUTS.length - result.count} already existed).`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
