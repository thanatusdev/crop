/**
 * Seeds demo data for the CROP MVP by bootstrapping the real Nest application context and
 * dispatching the same commands the HTTP API would -- this is deliberately not a raw SQL
 * script or a Prisma-only shortcut. Running it exercises the exact same validation, MFA
 * enrollment, and encryption paths a real signup would, so the seeded accounts are
 * guaranteed to behave identically to ones created through the UI.
 *
 * Requires apps/api to be built first (`pnpm --filter @crop/api build`), since it imports
 * the compiled AppModule -- see the comment in db:seed in the root package.json for why.
 */
import { NestFactory } from "@nestjs/core";
import { CommandBus } from "@nestjs/cqrs";
import * as OTPAuth from "otpauth";
import { TargetOs, MouseMode, TenantType, UserRole } from "@crop/shared";
import { DEMO_PASSWORD } from "./demo-password.js";
import { AppModule } from "../../apps/api/dist/app.module.js";
import { RegisterUserCommand } from "../../apps/api/dist/modules/iam/application/commands/register-user/register-user.command.js";
import { ConfirmMfaEnrollmentCommand } from "../../apps/api/dist/modules/iam/application/commands/enroll-mfa/confirm-mfa-enrollment.command.js";
import { CreateEquipmentCommand } from "../../apps/api/dist/modules/equipment/application/commands/create-equipment/create-equipment.command.js";
import { CreateQueueEntryCommand } from "../../apps/api/dist/modules/queue/application/commands/create-queue-entry/create-queue-entry.command.js";
import { CreateTenantCommand } from "../../apps/api/dist/modules/tenants/application/commands/create-tenant/create-tenant.command.js";

interface SeededUser {
  userId: string;
  email: string;
  password: string;
  role: UserRole;
  totpSecret: string;
}

function extractSecret(provisioningUri: string): string {
  const match = provisioningUri.match(/secret=([A-Z0-9]+)/i);
  if (!match) throw new Error(`Could not extract TOTP secret from ${provisioningUri}`);
  return match[1]!;
}

async function registerAndEnroll(
  commandBus: CommandBus,
  tenantId: string,
  email: string,
  password: string,
  role: UserRole
): Promise<SeededUser> {
  const { userId, enrollmentToken, provisioningUri } = await commandBus.execute(
    new RegisterUserCommand(tenantId, email, password, role)
  );
  const totpSecret = extractSecret(provisioningUri);
  const code = new OTPAuth.TOTP({ secret: totpSecret }).generate();
  await commandBus.execute(new ConfirmMfaEnrollmentCommand(enrollmentToken, code));
  return { userId, email, password, role, totpSecret };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const commandBus = app.get(CommandBus);

  console.log("Seeding tenants...");
  const alpha = await commandBus.execute(new CreateTenantCommand("Clinica Alpha", TenantType.CLINIC));
  const beta = await commandBus.execute(new CreateTenantCommand("Clinica Beta", TenantType.CLINIC));

  console.log("Seeding users (registering + auto-confirming MFA)...");
  const users: SeededUser[] = [];
  users.push(await registerAndEnroll(commandBus, alpha.id, "admin@alpha.crop.health", DEMO_PASSWORD, UserRole.CLINIC_ADMIN));
  users.push(await registerAndEnroll(commandBus, alpha.id, "operator@alpha.crop.health", DEMO_PASSWORD, UserRole.OPERATOR));
  users.push(await registerAndEnroll(commandBus, alpha.id, "supervisor@alpha.crop.health", DEMO_PASSWORD, UserRole.SUPERVISOR));
  users.push(await registerAndEnroll(commandBus, alpha.id, "auditor@alpha.crop.health", DEMO_PASSWORD, UserRole.AUDITOR));
  users.push(await registerAndEnroll(commandBus, beta.id, "operator@beta.crop.health", DEMO_PASSWORD, UserRole.OPERATOR));

  console.log("Seeding equipment (registering MRI-01 against a real or simulated PiKVM)...");
  const pikvmHost = process.env.SEED_PIKVM_HOST ?? "https://192.168.1.50";
  const pikvmUser = process.env.SEED_PIKVM_USER ?? "admin";
  const pikvmPassword = process.env.SEED_PIKVM_PASSWORD ?? "admin";
  // Unset by default: a room camera is opt-in per equipment, and pointing at MediaMTX before
  // anything is publishing to it just gives the demo a permanently-"connecting" PiP box.
  const cctvWhepUrl = process.env.SEED_MEDIAMTX_WHEP_URL ?? null;

  const alphaAdmin = users[0]!; // admin@alpha.crop.health, registered first, above
  const betaOperator = users[4]!; // operator@beta.crop.health -- beta has no admin seeded

  const mri = await commandBus.execute(
    new CreateEquipmentCommand(
      alpha.id,
      alphaAdmin.userId,
      "MRI-01",
      pikvmHost,
      pikvmUser,
      pikvmPassword,
      TargetOs.WINDOWS, // production target, per docs/architecture.md
      "pt-br",
      MouseMode.ABSOLUTE,
      1920,
      1080,
      cctvWhepUrl
    )
  );

  const ct = await commandBus.execute(
    new CreateEquipmentCommand(
      beta.id,
      betaOperator.userId,
      "CT-01",
      pikvmHost,
      pikvmUser,
      pikvmPassword,
      TargetOs.WINDOWS,
      "en-us",
      MouseMode.ABSOLUTE,
      1920,
      1080,
      null
    )
  );

  console.log("Seeding patient queue...");
  await commandBus.execute(new CreateQueueEntryCommand(alpha.id, alphaAdmin.userId, mri.id, "Maria", null));
  await commandBus.execute(new CreateQueueEntryCommand(alpha.id, alphaAdmin.userId, mri.id, "Joao", null));
  await commandBus.execute(new CreateQueueEntryCommand(beta.id, betaOperator.userId, ct.id, "Ana", null));

  await app.close();

  console.log("\n=== Seed complete ===\n");
  console.log("Tenants:");
  console.log(`  Clinica Alpha: ${alpha.id}`);
  console.log(`  Clinica Beta:  ${beta.id}`);
  console.log("\nUsers (password is the same for all, for demo convenience only):");
  for (const user of users) {
    console.log(`  ${user.email} [${user.role}]`);
    console.log(`    password:    ${user.password}`);
    console.log(`    TOTP secret: ${user.totpSecret}  (add to an authenticator app)`);
  }
  console.log(`\nEquipment: MRI-01 (${mri.id}) in Clinica Alpha, CT-01 (${ct.id}) in Clinica Beta`);
  console.log(`PiKVM target: ${pikvmHost} -- override with SEED_PIKVM_HOST/USER/PASSWORD env vars.`);
  console.log(
    cctvWhepUrl
      ? `CCTV: MRI-01's room camera PiP points at ${cctvWhepUrl}\n`
      : "CCTV: not configured -- set SEED_MEDIAMTX_WHEP_URL to enable the room-camera PiP on MRI-01.\n"
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // ioredis (via RedisModule) keeps a TCP socket open that app.close() does not tear down
    // on its own; this is a one-shot CLI script, not long-running app code, so an explicit
    // exit here is the pragmatic fix rather than adding lifecycle-hook plumbing to
    // RedisModule purely to satisfy a script that only ever runs once and quits.
    process.exit();
  });
