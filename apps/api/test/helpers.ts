import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import * as argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { PrismaClient } from "@prisma/client";
import { TenantType, UserRole, isRoleAllowedInTenantType } from "@crop/shared";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
// Imports the COMPILED app, not TS source -- NestJS's decorator metadata + argon2's native
// addon crash the Node process outright when loaded through Vitest's on-the-fly esbuild
// transform of the raw source; the exact same bootstrap against pre-built dist/ works
// perfectly. Run `nest build` before `test:e2e` (the npm script already does this), same
// tradeoff the seed script already accepts. See docs/architecture.md.
import { AppModule } from "../dist/app.module.js";
import { configureApp } from "../dist/configure-app.js";

export async function createTestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  // Same helmet()/CORS setup main.ts's real bootstrap applies -- see configureApp's own
  // docstring for why this has to be called explicitly here too, not something AppModule's
  // own providers can express.
  configureApp(app);
  await app.init();
  return app;
}

export interface TestUser {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Creates a ready-to-login user directly via Prisma + argon2 + otpauth, deliberately NOT by
 * dispatching `RegisterUserCommand` through the app's `CommandBus`. Attempting that hit a
 * dual-module-instance hazard: command/query classes imported directly into a test file are
 * loaded through Vitest's own module graph, which turned out to be a different instantiation
 * than the one `@CommandHandler(RegisterUserCommand)`'s metadata was actually attached to
 * inside the app's internally-`require()`'d dependency chain -- so the bus could never find
 * a handler for a command object built from "the same" class imported a second way.
 *
 * This only affects fixture *setup*. The actual login + MFA verification flow below runs
 * through the real HTTP endpoints via supertest, which is the part actually under test.
 */
export async function createLoggedInUser(
  app: INestApplication,
  params: { tenantId: string; role: UserRole; emailPrefix?: string; firstName?: string; lastName?: string }
): Promise<TestUser> {
  const prisma = new PrismaClient();
  const email = `${params.emailPrefix ?? "user"}-${crypto.randomUUID()}@test.crop.health`;
  const password = "TestPassword123!";
  const secret = new OTPAuth.Secret({ size: 20 }).base32;

  // Enforce the one invariant this fixture's Prisma shortcut would otherwise let tests
  // violate. `RegisterUserHandler` checks `isRoleAllowedInTenantType` on every real
  // registration; a direct `prisma.user.create` does not, which meant the suite could (and
  // for a long time did) build operator accounts inside CLINIC tenants -- a topology the
  // application itself refuses to create. Tests passing against data the product cannot
  // produce is worse than tests failing: it hides exactly the kind of cross-tenant
  // authorization bug this fixture is most often used to probe. Asserted here rather than
  // left to review, so it cannot silently reopen.
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: params.tenantId } });
  if (!isRoleAllowedInTenantType(params.role, tenant.type as TenantType)) {
    await prisma.$disconnect();
    throw new Error(
      `createLoggedInUser: role ${params.role} is not permitted in a ${tenant.type} tenant (see ROLE_TENANT_TYPES). ` +
        `For an operator-side role working a clinic's equipment, use createContractedOperator() instead.`
    );
  }

  await prisma.user.create({
    data: {
      tenantId: params.tenantId,
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: params.role,
      // Both left undefined (-> null, same as before this parameter existed) unless a
      // caller actually needs a resolved display name to assert against -- e.g. the
      // exam-detail attribution feature's "Registrado por <nome>", which the email-local-
      // part fallback (`displayNameOf`) would otherwise turn into an opaque "nurse-<uuid>".
      firstName: params.firstName,
      lastName: params.lastName,
      mfaSecret: secret,
      mfaEnabledAt: new Date(), // pre-enrolled -- enrollment itself is not what this suite tests
      // Pre-activated -- this fixture simulates an already-onboarded account (same
      // reasoning as `mfaEnabledAt` above), not one still waiting on its invitation link
      // (see RegisterUserHandler / LoginHandler's own `isActivated()` check).
      activatedAt: new Date(),
      // A real registration always grants membership in its own home tenant (see
      // RegisterUserHandler) -- without this row, a fixture CLINIC_ADMIN would fail
      // `RegisterUserHandler`'s own actor-scope check (`canGrantRole`'s clinic-membership
      // subset check) the moment a test has them register a clinic-side account, since
      // that check has nothing else to go on for a user created outside the real command.
      //
      // Only for a CLINIC home tenant, mirroring RegisterUserHandler exactly: membership
      // means "a clinic-side user who works at these clinics", so an OPERATOR_PROVIDER or
      // PLATFORM account must not get a row pointing at its own non-clinic tenant.
      clinicMemberships: tenant.type === "CLINIC" ? { create: [{ clinicTenantId: params.tenantId }] } : undefined,
    },
  });
  await prisma.$disconnect();

  const httpServer = app.getHttpServer();
  const request = (await import("supertest")).default;

  const loginRes = await request(httpServer)
    .post("/auth/login")
    .send({ email, password, clientOs: "MACOS" })
    .expect(200);
  const mfaToken = loginRes.body.mfaToken as string;

  const verifyCode = new OTPAuth.TOTP({ secret }).generate();
  const verifyRes = await request(httpServer).post("/auth/mfa/verify").send({ mfaToken, code: verifyCode }).expect(200);

  const decoded = JSON.parse(Buffer.from(verifyRes.body.accessToken.split(".")[1], "base64").toString());

  return {
    userId: decoded.sub,
    email,
    accessToken: verifyRes.body.accessToken,
    refreshToken: verifyRes.body.refreshToken,
  };
}

/**
 * Creates an operator-side account (`OPERATOR`, `OPERATIONAL_SUPERVISOR`, `OPERATOR_ADMIN`)
 * that can actually work a given clinic's equipment, and returns it already holding a token
 * scoped to that clinic.
 *
 * This exists because the role-model inversion (see packages/shared/src/roles.ts) made
 * `createLoggedInUser(app, { tenantId: someClinic, role: UserRole.OPERATOR })` illegal: an
 * operator belongs to the operating *company*, not to the clinic it operates. Reproducing the
 * real production path by hand at 70 call sites would have been both noisy and, predictably,
 * inconsistent between them -- so the whole four-step dance lives here:
 *
 *   1. find-or-create an OPERATOR_PROVIDER tenant for the clinic;
 *   2. link it (`Tenant.operatorTenantId`) -- the contract, as far as this phase models it;
 *   3. create the account inside the *provider* tenant;
 *   4. `POST /auth/active-clinic` to mint a token whose `tenantId` claim is the clinic.
 *
 * Step 4 is the important one, and it is a real HTTP round trip through
 * `SwitchActiveClinicHandler`, not a hand-forged token: it means every spec using this helper
 * is genuinely exercising the cross-tenant authorization path, and would fail if that path
 * regressed. It is also what keeps the *rest* of each spec unchanged -- the returned token's
 * tenant claim is the clinic, so every downstream `belongsToTenant` assertion behaves exactly
 * as it did when the operator lived in the clinic outright.
 *
 * Find-or-create in step 1, not create: a clinic has at most one operator tenant, and specs
 * routinely need two operator-side accounts on the same clinic (an operator plus the
 * supervisor who takes over from them). Those must land in the same provider company, which
 * is also what a real deployment looks like.
 */
export async function createContractedOperator(
  app: INestApplication,
  prisma: PrismaClient,
  params: { clinicTenantId: string; role: UserRole; emailPrefix?: string; firstName?: string; lastName?: string }
): Promise<TestUser> {
  const clinic = await prisma.tenant.findUniqueOrThrow({ where: { id: params.clinicTenantId } });
  if (clinic.type !== "CLINIC") {
    throw new Error(`createContractedOperator: ${params.clinicTenantId} is a ${clinic.type}, not a CLINIC`);
  }

  // One provider tenant per clinic, reused across calls: a clinic may contract several companies,
  // but specs routinely need two operator-side accounts who must be *colleagues* (an operator plus
  // the supervisor who takes over from them), and putting those in separate companies would make
  // every takeover spec fail for the wrong reason.
  let agreement = await prisma.operatorAgreement.findFirst({
    where: { clinicTenantId: clinic.id, status: "ACTIVE" },
  });
  if (!agreement) {
    const provider = await prisma.tenant.create({
      data: { name: `Operadora-${crypto.randomUUID().slice(0, 8)}`, type: "OPERATOR_PROVIDER" },
    });
    agreement = await prisma.operatorAgreement.create({
      data: {
        clinicTenantId: clinic.id,
        operatorTenantId: provider.id,
        status: "ACTIVE",
        proposedByTenantId: clinic.id,
        respondedAt: new Date(),
      },
    });
  }

  await grantWholeClinicScope(prisma, agreement.id, clinic.id);

  const user = await createLoggedInUser(app, {
    tenantId: agreement.operatorTenantId,
    role: params.role,
    emailPrefix: params.emailPrefix ?? "operator",
    firstName: params.firstName,
    lastName: params.lastName,
  });

  const request = (await import("supertest")).default;
  const switched = await request(app.getHttpServer())
    .post("/auth/active-clinic")
    .set("Authorization", `Bearer ${user.accessToken}`)
    .send({ clinicTenantId: params.clinicTenantId })
    .expect(200);

  return {
    userId: user.userId,
    email: user.email,
    accessToken: switched.body.accessToken as string,
    refreshToken: switched.body.refreshToken as string,
  };
}

/**
 * Grants an agreement every unit its clinic currently has, creating the clinic's default unit first
 * if it has none.
 *
 * Unit-level rather than equipment-level, and this is the detail that makes the whole fixture work:
 * most specs create their equipment *after* the operator, and `CreateEquipmentHandler` files
 * equipment with no explicit `unitId` under the clinic's **oldest** unit. Granting units therefore
 * covers equipment that does not exist yet -- which is exactly the property unit grants were
 * designed for (see the OperatorAgreementScope model), so the fixture exercises it rather than
 * working around it.
 *
 * This is deliberately the one place in the codebase that still *chooses* a unit grant: the real
 * scope modal (`AgreementsPage.tsx`) offers equipment-level grants exclusively now, and a unit
 * grant is otherwise a legacy shape most agreements only hold because they predate that change.
 * Using it here is a test-convenience trade, not a product recommendation -- see
 * `operator-agreements.e2e.spec.ts`'s own equipment-level tests for the shape real contracts take.
 *
 * Exported because a spec that creates a *new* unit after its operator, and puts equipment there
 * explicitly, is outside that guarantee and has to re-grant. Idempotent, so calling it again is
 * always safe.
 */
export async function grantWholeClinicScope(prisma: PrismaClient, agreementId: string, clinicTenantId: string): Promise<void> {
  let units = await prisma.unit.findMany({ where: { clinicTenantId }, select: { id: true } });
  if (units.length === 0) {
    // Same name CreateEquipmentHandler would use, so it adopts this unit rather than creating a
    // second one that would then be the oldest and fall outside the grant.
    const created = await prisma.unit.create({
      // `declaredModalities` has no database default -- it is a required scalar list, so an empty
      // array has to be explicit here even though the domain treats "none declared" as normal.
      data: { clinicTenantId, name: "Unidade Principal", declaredModalities: [] },
    });
    units = [{ id: created.id }];
  }
  await prisma.operatorAgreementScope.createMany({
    data: units.map((unit) => ({ agreementId, unitId: unit.id })),
    skipDuplicates: true,
  });
}

/**
 * A fresh, independent PrismaClient (reading DATABASE_URL from process.env, same as the
 * app's own instance) for fixture setup -- tenants, equipment, forcing equipment ONLINE --
 * never used to make assertions. Deliberately NOT fetched via `app.get(PrismaService)`: the
 * same dual-module-instance hazard applies there too (see the docstring above).
 */
export function testPrisma(): PrismaClient {
  return new PrismaClient();
}

export async function createTenant(prisma: PrismaClient, name: string, type: "CLINIC" | "OPERATOR_PROVIDER" | "PLATFORM" = "CLINIC") {
  return prisma.tenant.create({ data: { name, type } });
}

/**
 * A fresh, structurally-valid CNPJ for test fixtures -- real check digits computed from a
 * random 12-digit base, using the same mod-11 algorithm `packages/shared/src/cnpj.ts`
 * validates against (deliberately re-implemented here rather than exported from that
 * module for test use: generating a fake-but-valid identifier is a test-fixture concern,
 * not something the production CNPJ module has any other reason to do).
 */
function generateValidCnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join("");
  const digits = base.split("").map(Number);
  const weightedMod11 = (values: number[], weights: number[]) => {
    const sum = values.reduce((total, value, index) => total + value * weights[index]!, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const firstCheck = weightedMod11(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondCheck = weightedMod11([...digits, firstCheck], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${firstCheck}${secondCheck}`;
}

/**
 * A valid `POST /tenants` body for a CLINIC, mirroring `equipmentPayload`/`unitPayload`'s
 * reason for existing: `CreateTenantRequestSchema` requires a clinic's institutional
 * identity and address (via its own `.superRefine`) on top of a name, and hand-copying that
 * into every spec that merely needs *a* clinic to exist is how one of them ends up subtly
 * different from the rest for no reason. A fresh `generateValidCnpj()` per call, since CNPJ
 * is unique -- reusing a literal across tests would 409 the second one.
 */
export function clinicPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Test-Clinic-${crypto.randomUUID().slice(0, 8)}`,
    type: "CLINIC",
    cnpj: generateValidCnpj(),
    institutionalEmail: "contato@test.crop.health",
    phone: "(11) 3456-7890",
    zipCode: "01310-100",
    street: "Avenida Paulista",
    number: "1000",
    district: "Bela Vista",
    city: "São Paulo",
    state: "SP",
    ...overrides,
  };
}

/** `OPERATOR_PROVIDER` counterpart to `clinicPayload` -- same required institutional fields,
 * same reasoning (a fresh `generateValidCnpj()` per call so repeated test runs never 409 on
 * CNPJ uniqueness), different `type` and a name that reads like a company rather than a
 * clinic. */
export function operatorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Test-Operator-${crypto.randomUUID().slice(0, 8)}`,
    type: "OPERATOR_PROVIDER",
    cnpj: generateValidCnpj(),
    institutionalEmail: "contato@test-operator.crop.health",
    phone: "(11) 2345-6789",
    zipCode: "04567-002",
    street: "Avenida Faria Lima",
    number: "500",
    district: "Itaim Bibi",
    city: "São Paulo",
    state: "SP",
    ...overrides,
  };
}

/**
 * Decodes the unsigned payload of a JWT access token to read its claims (`sub`/`tenantId`/
 * `role`) without a network round trip -- the same decode `createLoggedInUser` already does
 * internally to return `userId`. Exposed here for specs that only captured `accessToken`
 * from an earlier `createLoggedInUser` call and later need the user id back out (e.g. as a
 * unit's `technicalManagerId` -- see `unitPayload`).
 */
export function decodeAccessToken(accessToken: string): { sub: string; tenantId: string; role: string } {
  return JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64").toString());
}

/**
 * A valid `POST /units` body, mirroring `equipmentPayload`'s reason for existing:
 * `CreateUnitRequestSchema` requires a unit's institutional identity and physical address on
 * top of its clinic link, and hand-copying that into every spec that merely needs *a* unit
 * to exist is how one of them ends up subtly different from the rest for no reason.
 *
 * Unlike `equipmentPayload`, `technicalManagerId` cannot be filled in with a fixed dummy
 * value: `CreateUnitHandler` validates it against a real user who belongs to the *target*
 * clinic and holds an eligible role (see `TechnicalManagerValidator`). Pass the id of such a
 * user -- often the same `CLINIC_ADMIN` whose token is making the request, since
 * `CLINIC_ADMIN` is itself an eligible role (use `decodeAccessToken(token).sub`).
 */
export function unitPayload(technicalManagerId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Test-Unit-${crypto.randomUUID().slice(0, 8)}`,
    establishmentType: "LABORATORY",
    technicalManagerId,
    declaredModalities: ["MRI"],
    zipCode: "01310-100",
    street: "Avenida Paulista",
    number: "1000",
    district: "Bela Vista",
    city: "São Paulo",
    state: "SP",
    ...overrides,
  };
}

/**
 * A valid `POST /equipment` body, for the many specs across this suite whose subject is not
 * equipment registration itself (session lifecycle, takeover, queue isolation, the WS
 * gateway, ...) but which each need a piece of equipment to exist first.
 *
 * It exists because `CreateEquipmentRequestSchema` requires a device's clinical identity
 * (modality, brand, model, serial, room, install date) on top of its teleoperation config.
 * Those fields are genuinely required -- the nullable columns behind them exist only for rows
 * predating the registration screen, and nothing new may join that set -- but a spec about
 * supervisor takeover has no business restating a scanner's brand and serial number to get
 * there, and hand-copying the full payload into every file is how one of them ends up subtly
 * different from the rest for no reason.
 *
 * Pass `overrides` for the fields a given test actually cares about.
 */
export function equipmentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Test-Equipment-${crypto.randomUUID().slice(0, 8)}`,
    modality: "MRI",
    brand: "Siemens",
    model: "Magnetom Vida 3.0T",
    serialNumber: "TEST-SN-000",
    roomLabel: "Sala de Testes",
    installedAt: "2025-01-15",
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737), reserved for documentation and guaranteed not
    // to route anywhere -- these hosts are never meant to answer. The health poller is
    // disabled in this environment anyway (DISABLE_HEALTH_POLLER, see setup-env.ts).
    pikvmHost: "https://192.0.2.1",
    pikvmUser: "admin",
    pikvmPassword: "Password123!",
    targetOs: "WINDOWS",
    ...overrides,
  };
}

interface OutboxEntry {
  to: string;
  subject: string;
  html: string;
  text: string;
  sentAt: string;
}

/**
 * Reads `MAIL_OUTBOX_PATH` (see setup-env.ts -- a test-only path, distinct from the dev
 * default) and returns the most recently appended message to `email`, or `null` if none
 * exists yet. "Most recent" matters because the file is appended-to, never truncated,
 * across every test file's own app instance in one `pnpm test:e2e` run -- a re-request
 * against the same fixture email later in the suite must not accidentally read back an
 * earlier message.
 */
export async function readLatestMailTo(email: string): Promise<OutboxEntry | null> {
  const path = resolve(process.env.MAIL_OUTBOX_PATH ?? "./storage/mail-outbox.jsonl");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null; // nothing sent yet
  }
  const entries: OutboxEntry[] = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OutboxEntry)
    .filter((entry) => entry.to === email);
  return entries.length > 0 ? entries[entries.length - 1]! : null;
}

/** Pulls the `token=...` query param out of the reset link inside a sent email's `text`
 * body -- deliberately from `text`, not `html`, so this doesn't depend on the HTML template
 * staying regex-friendly. */
export function extractResetToken(mail: OutboxEntry): string {
  const match = mail.text.match(/[?&]token=([^\s&]+)/);
  if (!match) throw new Error(`Could not find a reset token in mail text: ${mail.text}`);
  return decodeURIComponent(match[1]!);
}
