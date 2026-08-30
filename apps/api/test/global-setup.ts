/**
 * Runs once before the entire e2e suite: drops and recreates a dedicated `crop_test`
 * database (never the dev `crop` database) and applies every migration to it, so each test
 * run starts from a pristine, fully-migrated schema regardless of what a previous run left
 * behind.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";

const ADMIN_CONNECTION = "postgresql://crop:crop_dev_password@localhost:5433/postgres";
const TEST_DATABASE_URL = "postgresql://crop:crop_dev_password@localhost:5433/crop_test";

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_CONNECTION });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS crop_test");
    await admin.query("CREATE DATABASE crop_test");
  } finally {
    await admin.end();
  }

  execSync("npx prisma migrate deploy", {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });
}
