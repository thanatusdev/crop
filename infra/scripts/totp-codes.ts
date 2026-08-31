/**
 * Prints live login credentials -- email, the shared demo password, and a *currently valid*
 * TOTP code with its remaining seconds -- for every seeded user, straight from the database.
 *
 * Deliberately reads mfaSecret directly from Postgres rather than reusing whatever seed.ts
 * printed at seed time: that printout is a one-shot snapshot whose TOTP codes are stale
 * within 30 seconds, and the secrets themselves scroll off long before a demo is over. This
 * script has no such expiry -- run it any time, as many times as needed, for fresh codes.
 *
 * Usage: pnpm --filter @crop/api exec tsx ../../infra/scripts/totp-codes.ts
 * (wired up as `make totp` -- see the Makefile).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import * as OTPAuth from "otpauth";
import { DEMO_PASSWORD } from "../seeds/demo-password.js";

/** apps/api reads its own .env via @nestjs/config; this script isn't a Nest app, so it
 * needs its own minimal, dependency-free loader for the one variable it actually needs. */
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

  const users = await prisma.user.findMany({
    include: { tenant: { select: { name: true } } },
    orderBy: [{ tenant: { name: "asc" } }, { email: "asc" }],
  });

  if (users.length === 0) {
    console.log("No users found -- run `make seed` (or `pnpm db:seed`) first.");
    await prisma.$disconnect();
    return;
  }

  const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`Live TOTP codes below are valid for ${secondsRemaining}s -- rotate every 30s, re-run this if they expire.\n`);

  for (const user of users) {
    const code = user.mfaSecret ? new OTPAuth.TOTP({ secret: user.mfaSecret }).generate() : null;
    const status = user.lockedAt ? " [LOCKED]" : "";
    console.log(`${user.tenant.name} -- ${user.email} [${user.role}]${status}`);
    console.log(`  password: ${DEMO_PASSWORD}`);
    console.log(`  TOTP:     ${code ?? "(not enrolled)"}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
