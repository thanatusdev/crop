/**
 * Creates the one "Platform Operations" tenant (TenantType.PLATFORM) and its *first*
 * PLATFORM_ADMIN account. There is deliberately no unauthenticated or self-service way to do
 * this; every later platform admin is invited by an existing one from the panel
 * (`POST /platform/admins`). Run this once, locally or against a deployed instance (see
 * DEPLOY.md for the `railway ssh` equivalent).
 *
 * The demo password default is for local use only: with NODE_ENV=production this refuses to
 * run unless SUPERADMIN_PASSWORD is set to something else.
 *
 * Idempotent: if a PLATFORM-type tenant already exists, this prints its id and exits without
 * creating a second one or a second superadmin -- safe to re-run, e.g. after a redeploy, by
 * accident, or by a teammate who doesn't know it's already been done.
 *
 * Same "dispatch real commands through a real Nest app context" shape as seed.ts, for the
 * same reason: the resulting account should behave identically to one created any other way,
 * not take a raw-SQL shortcut. Requires apps/api to be built first, same as seed.ts.
 */
import { NestFactory } from "@nestjs/core";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import * as OTPAuth from "otpauth";
import { TenantType, UserRole } from "@crop/shared";
import { AppModule } from "../../apps/api/dist/app.module.js";
import { RegisterUserCommand } from "../../apps/api/dist/modules/iam/application/commands/register-user/register-user.command.js";
import { ConfirmMfaEnrollmentCommand } from "../../apps/api/dist/modules/iam/application/commands/enroll-mfa/confirm-mfa-enrollment.command.js";
import { CreateTenantCommand } from "../../apps/api/dist/modules/tenants/application/commands/create-tenant/create-tenant.command.js";
import { ListTenantsQuery } from "../../apps/api/dist/modules/tenants/application/queries/list-tenants/list-tenants.query.js";

const DEMO_PASSWORD = "SenhaForte123!";

function extractSecret(provisioningUri: string): string {
  const match = provisioningUri.match(/secret=([A-Z0-9]+)/i);
  if (!match) throw new Error(`Could not extract TOTP secret from ${provisioningUri}`);
  return match[1]!;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const commandBus = app.get(CommandBus);
  const queryBus = app.get(QueryBus);

  // `ListTenantsQuery` resolves to `EnrichedTenant[]` (`{tenant, equipmentCount, ...}[]`),
  // not `Tenant[]` -- unwrapped immediately. Missing this once already broke this exact
  // idempotency check silently (it always read `undefined` for `type`/`id`/`name`, so this
  // script would have created a second PLATFORM tenant on every re-run instead of detecting
  // the first one -- caught before it ever ran, not after).
  const existingTenants: Array<{ tenant: { id: string; type: string; name: string } }> = await queryBus.execute(new ListTenantsQuery());
  const existingPlatformTenant = existingTenants.map((entry) => entry.tenant).find((t) => t.type === TenantType.PLATFORM);

  if (existingPlatformTenant) {
    console.log(`Already bootstrapped -- PLATFORM tenant "${existingPlatformTenant.name}" (${existingPlatformTenant.id}) already exists.`);
    console.log("Not creating a second one. Use `make totp` / the equivalent tsx script to get a login code for the existing superadmin.");
    await app.close();
    return;
  }

  const email = process.env.SUPERADMIN_EMAIL ?? "superadmin@crop.health";
  const password = process.env.SUPERADMIN_PASSWORD ?? DEMO_PASSWORD;
  if (process.env.NODE_ENV === "production" && password === DEMO_PASSWORD) {
    console.error("Refusing to create the superadmin with the demo password in production. Set SUPERADMIN_PASSWORD.");
    process.exitCode = 1;
    await app.close();
    return;
  }

  console.log("Creating the Platform Operations tenant...");
  // `CommandBus.execute` for `CreateTenantCommand` resolves to an `EnrichedTenant`
  // (`{tenant, equipmentCount, ...}`), not a bare `Tenant` -- destructured immediately, the
  // same lesson `seed.ts`'s own `alpha`/`beta` already learned once for this exact command.
  const { tenant: platformTenant } = await commandBus.execute(new CreateTenantCommand("Platform Operations", TenantType.PLATFORM));

  console.log("Creating the superadmin account (registering + auto-confirming MFA)...");
  const { userId, enrollmentToken, provisioningUri } = await commandBus.execute(
    // directActivation: {password} -- same reasoning as seed.ts's registerAndEnroll: this
    // script auto-confirms MFA a few lines down, simulating an already-onboarded account
    // rather than sending it through the invitation-link flow.
    new RegisterUserCommand(platformTenant.id, email, UserRole.PLATFORM_ADMIN, "Super", "Admin", null, null, null, [], true, { password })
  );
  const totpSecret = extractSecret(provisioningUri);
  const code = new OTPAuth.TOTP({ secret: totpSecret }).generate();
  await commandBus.execute(new ConfirmMfaEnrollmentCommand(enrollmentToken, code));

  await app.close();

  console.log("\n=== Superadmin bootstrap complete ===\n");
  console.log(`Platform Operations tenant: ${platformTenant.id}`);
  console.log(`Superadmin user: ${userId}`);
  console.log(`  email:       ${email}`);
  console.log(`  password:    ${password}`);
  console.log(`  TOTP secret: ${totpSecret}  (add to an authenticator app)`);
  console.log("\nOverride email/password via SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD env vars.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Same ioredis-keeps-a-socket-open reasoning as seed.ts -- see its own comment.
    process.exit();
  });
