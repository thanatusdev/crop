import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import * as argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { PrismaClient } from "@prisma/client";
import { UserRole } from "@crop/shared";
// Imports the COMPILED app, not TS source -- NestJS's decorator metadata + argon2's native
// addon crash the Node process outright when loaded through Vitest's on-the-fly esbuild
// transform of the raw source; the exact same bootstrap against pre-built dist/ works
// perfectly. Run `nest build` before `test:e2e` (the npm script already does this), same
// tradeoff the seed script already accepts. See docs/architecture.md.
import { AppModule } from "../dist/app.module.js";

export async function createTestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
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
  params: { tenantId: string; role: UserRole; emailPrefix?: string }
): Promise<TestUser> {
  const prisma = new PrismaClient();
  const email = `${params.emailPrefix ?? "user"}-${crypto.randomUUID()}@test.crop.health`;
  const password = "TestPassword123!";
  const secret = new OTPAuth.Secret({ size: 20 }).base32;

  await prisma.user.create({
    data: {
      tenantId: params.tenantId,
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: params.role,
      mfaSecret: secret,
      mfaEnabledAt: new Date(), // pre-enrolled -- enrollment itself is not what this suite tests
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
