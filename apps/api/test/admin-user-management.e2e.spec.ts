import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import * as OTPAuth from "otpauth";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * Covers the gap found live-demoing the app: CLINIC_ADMIN saw the exact same dashboard as
 * every other role, with no way to list/create users -- even though lock/unlock/reset-
 * password already existed server-side (see account-lockout.e2e.spec.ts) with nothing to
 * list a tenant's users to act on in the first place. This adds GET /users (list) and
 * POST /users (admin-driven creation, deliberately excluding PLATFORM_ADMIN -- see
 * CreateUserRequestSchema's own comment for why).
 */
describe("Admin user management: listing and creation", () => {
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
    tenantId = (await createTenant(prisma, `AdminUsers-${crypto.randomUUID()}`)).id;
    otherTenantId = (await createTenant(prisma, `AdminUsersOther-${crypto.randomUUID()}`)).id;
    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("lists only the calling admin's own tenant's users, never leaking passwordHash/mfaSecret", async () => {
    await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "list-mine" });
    const otherAdminToken = (
      await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "list-other-admin" })
    ).accessToken;
    await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.OPERATOR, emailPrefix: "list-not-mine" });

    const res = await http.get("/users").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const u of res.body) {
      expect(u.tenantId).toBe(tenantId);
      expect(u).not.toHaveProperty("passwordHash");
      expect(u).not.toHaveProperty("mfaSecret");
    }
    expect(res.body.some((u: { email: string }) => u.email.includes("list-not-mine"))).toBe(false);

    // Sanity check the fixture actually did what it claims: the other tenant's admin can
    // see that tenant's own user, just not this one's.
    const otherRes = await http.get("/users").set("Authorization", `Bearer ${otherAdminToken}`).expect(200);
    expect(otherRes.body.some((u: { email: string }) => u.email.includes("list-mine"))).toBe(false);
  });

  it("rejects a non-admin trying to list users", async () => {
    const operatorToken = (await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "list-rbac" })).accessToken;
    await http.get("/users").set("Authorization", `Bearer ${operatorToken}`).expect(403);
  });

  it("creates a user in the admin's own tenant, and only returns the new userId -- no password/secret echoed back", async () => {
    const email = `created-${crypto.randomUUID()}@test.crop.health`;
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, password: "BrandNewUser123!", role: "OPERATOR" })
      .expect(201);

    expect(Object.keys(res.body)).toEqual(["userId"]);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.tenantId).toBe(tenantId);
    expect(created.role).toBe("OPERATOR");
    expect(created.mfaEnabledAt).toBeNull(); // not enrolled yet -- that's on the new user's own first login
  });

  it("rejects a non-admin trying to create a user", async () => {
    const operatorToken = (await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR, emailPrefix: "create-rbac" })).accessToken;
    await http
      .post("/users")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ email: `blocked-${crypto.randomUUID()}@test.crop.health`, password: "Whatever123!", role: "OPERATOR" })
      .expect(403);
  });

  it("rejects creating a PLATFORM_ADMIN through this endpoint", async () => {
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: `escalation-${crypto.randomUUID()}@test.crop.health`, password: "Whatever123!", role: "PLATFORM_ADMIN" })
      .expect(400);
    // Nest's BadRequestException wraps ZodValidationPipe's rejection as { message: [...Zod
    // issues], error, statusCode } -- confirming the one issue is specifically about `role`
    // being invalid, not just that *something* about the request was malformed.
    expect(res.body.message).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["role"] })]));
  });

  it("lets a freshly admin-created user log in with the temp password and complete their own MFA enrollment -- no mailer involved anywhere", async () => {
    const email = `self-enroll-${crypto.randomUUID()}@test.crop.health`;
    const password = "TempPassword789!";
    const createRes = await http
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, password, role: "OPERATOR" })
      .expect(201);

    // The new user's own first login -- the admin never sees a provisioningUri or secret at
    // any point in this test, matching what the real UsersController route returns.
    const loginRes = await http.post("/auth/login").send({ email, password, clientOs: "WINDOWS" }).expect(200);
    expect(loginRes.body.status).toBe("mfa_enrollment_required");
    expect(loginRes.body.provisioningUri).toContain("secret=");

    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: createRes.body.userId } })).mfaSecret!;
    const code = new OTPAuth.TOTP({ secret }).generate();
    await http
      .post("/auth/mfa/enroll/confirm")
      .send({ enrollmentToken: loginRes.body.enrollmentToken, code })
      .expect(204);

    // Enrollment is done -- logging in again now goes down the normal mfa_required path,
    // not another enrollment prompt.
    const secondLogin = await http.post("/auth/login").send({ email, password, clientOs: "WINDOWS" }).expect(200);
    expect(secondLogin.body.status).toBe("mfa_required");
  });
});
