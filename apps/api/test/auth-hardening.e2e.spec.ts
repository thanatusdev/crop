import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import * as OTPAuth from "otpauth";
import * as argon2 from "argon2";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

describe("Auth hardening: rate limiting and logout revocation", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    tenantId = (await createTenant(prisma, `RateLimit-${crypto.randomUUID()}`)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  // Each `it` below creates its own user with a fresh, randomly-generated email, so the
  // `ratelimit:login:${email}` / `ratelimit:mfa:${userId}` Redis keys never collide between
  // tests -- no explicit Redis flush needed between cases.

  it("locks out login after 10 failed password attempts within the window", async () => {
    const email = `lockout-${crypto.randomUUID()}@test.crop.health`;
    await prisma.user.create({
      data: {
        tenantId,
        email,
        passwordHash: await argon2.hash("TestPassword123!", { type: argon2.argon2id }),
        role: UserRole.OPERATOR,
        mfaSecret: new OTPAuth.Secret({ size: 20 }).base32,
        mfaEnabledAt: new Date(),
      },
    });

    for (let i = 0; i < 10; i++) {
      await http.post("/auth/login").send({ email, password: "wrong-password", clientOs: "MACOS" }).expect(401);
    }

    const res = await http.post("/auth/login").send({ email, password: "wrong-password", clientOs: "MACOS" }).expect(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");

    // Even the CORRECT password is rejected once locked out -- the limiter counts attempts
    // against the email, not just failures, so it can't be bypassed by finally guessing right.
    const correctRes = await http
      .post("/auth/login")
      .send({ email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(429);
    expect(correctRes.body.code).toBe("TOO_MANY_REQUESTS");
  });

  it("locks out MFA verification after 10 wrong codes within the window", async () => {
    const email = `mfa-lockout-${crypto.randomUUID()}@test.crop.health`;
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await prisma.user.create({
      data: {
        tenantId,
        email,
        passwordHash: await argon2.hash("TestPassword123!", { type: argon2.argon2id }),
        role: UserRole.OPERATOR,
        mfaSecret: secret,
        mfaEnabledAt: new Date(),
      },
    });

    const loginRes = await http
      .post("/auth/login")
      .send({ email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(200);
    const mfaToken = loginRes.body.mfaToken as string;

    for (let i = 0; i < 10; i++) {
      await http.post("/auth/mfa/verify").send({ mfaToken, code: "000000" }).expect(401);
    }

    const res = await http.post("/auth/mfa/verify").send({ mfaToken, code: "000000" }).expect(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");

    // Even the correct TOTP code is rejected once locked out.
    const correctCode = new OTPAuth.TOTP({ secret }).generate();
    const correctRes = await http.post("/auth/mfa/verify").send({ mfaToken, code: correctCode }).expect(429);
    expect(correctRes.body.code).toBe("TOO_MANY_REQUESTS");
  });

  it("rejects a refresh with a revoked (logged-out) refresh token", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "logout" });

    await http.post("/auth/logout").send({ refreshToken: user.refreshToken }).expect(204);

    const res = await http.post("/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("rotates the refresh token on use: the old one is rejected after a refresh", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "rotate" });

    const refreshRes = await http.post("/auth/refresh").send({ refreshToken: user.refreshToken }).expect(200);
    expect(refreshRes.body.refreshToken).not.toBe(user.refreshToken);

    // Replaying the now-retired original refresh token must fail, not silently succeed.
    const replayRes = await http.post("/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
    expect(replayRes.body.code).toBe("UNAUTHORIZED");

    // The newly issued refresh token, however, still works.
    await http.post("/auth/refresh").send({ refreshToken: refreshRes.body.refreshToken }).expect(200);
  });
});
