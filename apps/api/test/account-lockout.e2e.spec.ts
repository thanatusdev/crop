import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import * as OTPAuth from "otpauth";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

describe("Account lockout and admin password reset", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;
  let otherTenantId: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    tenantId = (await createTenant(prisma, `Lockout-${crypto.randomUUID()}`)).id;
    otherTenantId = (await createTenant(prisma, `LockoutOther-${crypto.randomUUID()}`)).id;
    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("blocks login, then restores it, across a lock/unlock cycle", async () => {
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "lock-cycle" });

    await http.get(`/users/${target.userId}`).set("Authorization", `Bearer ${adminToken}`).expect(200).then((res) => {
      expect(res.body.locked).toBe(false);
    });

    await http.post(`/users/${target.userId}/lock`).set("Authorization", `Bearer ${adminToken}`).expect(204);

    await http.get(`/users/${target.userId}`).set("Authorization", `Bearer ${adminToken}`).expect(200).then((res) => {
      expect(res.body.locked).toBe(true);
    });

    const lockedLogin = await http
      .post("/auth/login")
      .send({ email: target.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(403);
    expect(lockedLogin.body.code).toBe("FORBIDDEN");

    // The refresh token issued before the lock is rejected too, not just fresh logins.
    const lockedRefresh = await http.post("/auth/refresh").send({ refreshToken: target.refreshToken }).expect(403);
    expect(lockedRefresh.body.code).toBe("FORBIDDEN");

    await http.post(`/users/${target.userId}/unlock`).set("Authorization", `Bearer ${adminToken}`).expect(204);

    await http
      .post("/auth/login")
      .send({ email: target.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(200);
  });

  it("rejects completing MFA verification for an account locked mid-flow", async () => {
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "lock-mid-mfa" });
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).mfaSecret!;

    const loginRes = await http
      .post("/auth/login")
      .send({ email: target.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(200);
    const mfaToken = loginRes.body.mfaToken as string;

    await http.post(`/users/${target.userId}/lock`).set("Authorization", `Bearer ${adminToken}`).expect(204);

    const code = new OTPAuth.TOTP({ secret }).generate();
    const res = await http.post("/auth/mfa/verify").send({ mfaToken, code }).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rejects a non-admin trying to lock another user", async () => {
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "lock-rbac-target" });
    const nonAdminToken = (
      await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "lock-rbac-actor" })
    ).accessToken;

    await http.post(`/users/${target.userId}/lock`).set("Authorization", `Bearer ${nonAdminToken}`).expect(403);
  });

  it("rejects locking, unlocking, or viewing a user from a different tenant", async () => {
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "lock-cross-tenant" });
    const otherAdminToken = (
      await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "other-admin" })
    ).accessToken;

    await http.get(`/users/${target.userId}`).set("Authorization", `Bearer ${otherAdminToken}`).expect(403);
    await http.post(`/users/${target.userId}/lock`).set("Authorization", `Bearer ${otherAdminToken}`).expect(403);
    await http.post(`/users/${target.userId}/unlock`).set("Authorization", `Bearer ${otherAdminToken}`).expect(403);
  });

  it("lets an admin force a password reset that immediately supersedes the old password", async () => {
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "reset-pw" });

    await http
      .post(`/users/${target.userId}/reset-password`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ newPassword: "BrandNewPassword456!" })
      .expect(204);

    await http
      .post("/auth/login")
      .send({ email: target.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(401);

    await http
      .post("/auth/login")
      .send({ email: target.email, password: "BrandNewPassword456!", clientOs: "MACOS" })
      .expect(200);
  });

  it("never leaks passwordHash or mfaSecret through GET /users/:id", async () => {
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "no-leak" });

    const res = await http.get(`/users/${target.userId}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(res.body).not.toHaveProperty("passwordHash");
    expect(res.body).not.toHaveProperty("mfaSecret");
    expect(res.body.mfaEnrolled).toBe(true);
  });
});
