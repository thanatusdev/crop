import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, readLatestMailTo, extractResetToken } from "./helpers.js";

/**
 * Self-service password reset via email -- reverses a previously deliberate "no self-service
 * flow" decision (see docs/architecture.md and AdminResetPasswordHandler's own docstring) now
 * that a mailer exists. Runs against the real file-outbox `MailerPort` adapter (see
 * setup-env.ts's `MAILER_DRIVER=file`/`MAIL_OUTBOX_PATH`), not a mock -- this exercises the
 * actual email-rendering path (`password-reset-email.ts`), not just the handler logic around
 * it.
 */
describe("Password reset via email", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    tenantId = (await createTenant(prisma, `PwReset-${crypto.randomUUID()}`)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("requests a reset, redeems the emailed link, and the new password reaches the normal MFA step -- old password and old refresh token stop working", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "reset-happy" });

    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);

    const mail = await readLatestMailTo(user.email);
    expect(mail).not.toBeNull();
    expect(mail!.subject).toContain("Redefinição de senha");
    const token = extractResetToken(mail!);

    await http.post("/auth/password-reset/confirm").send({ token, newPassword: "BrandNewPassword123!" }).expect(204);

    // Old password no longer works.
    await http
      .post("/auth/login")
      .send({ email: user.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(401);

    // New password reaches the normal mfa_required step -- 2FA still gates login even
    // though the reset link alone set the password (see RequestPasswordResetHandler's
    // docstring / the task's own "email link alone is enough" decision).
    const loginRes = await http
      .post("/auth/login")
      .send({ email: user.email, password: "BrandNewPassword123!", clientOs: "MACOS" })
      .expect(200);
    expect(loginRes.body.status).toBe("mfa_required");

    // The refresh token issued before the reset must not survive it.
    const refreshRes = await http.post("/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
    expect(refreshRes.body.code).toBe("UNAUTHORIZED");
  });

  it("validates a fresh token, returning identity fields and an expiry, without burning its single use", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "validate-happy" });
    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const token = extractResetToken((await readLatestMailTo(user.email))!);

    const res = await http.get("/auth/password-reset/validate").query({ token }).expect(200);
    expect(res.body.email).toBe(user.email);
    expect(res.body.role).toBe("LOCAL_IT");
    // createLoggedInUser is a raw Prisma fixture (see helpers.ts) -- it never sets names, so
    // these stay null, exactly like a historical pre-this-feature account would.
    expect(res.body.firstName).toBeNull();
    expect(res.body.lastName).toBeNull();
    expect(res.body.professionalRegistration).toBeNull();
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Read-only: validating does not deny the jti, so the same token can still be confirmed.
    await http.post("/auth/password-reset/confirm").send({ token, newPassword: "GiraffeJump42!" }).expect(204);
  });

  it("rejects validating an already-used token, and a garbage one", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "validate-once" });
    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const token = extractResetToken((await readLatestMailTo(user.email))!);
    await http.post("/auth/password-reset/confirm").send({ token, newPassword: "MarbleFloor77!" }).expect(204);

    const usedRes = await http.get("/auth/password-reset/validate").query({ token }).expect(401);
    expect(usedRes.body.code).toBe("UNAUTHORIZED");

    const garbageRes = await http.get("/auth/password-reset/validate").query({ token: "not-a-real-jwt" }).expect(401);
    expect(garbageRes.body.code).toBe("UNAUTHORIZED");
  });

  it("returns the identical response for an email that doesn't exist, and sends nothing", async () => {
    const unknownEmail = `nobody-${crypto.randomUUID()}@test.crop.health`;
    const res = await http.post("/auth/password-reset/request").send({ email: unknownEmail }).expect(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(await readLatestMailTo(unknownEmail)).toBeNull();
  });

  it("silently no-ops for a locked account, without revealing that via the response", async () => {
    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "reset-lock-admin" });
    const locked = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "reset-locked" });
    await http.post(`/users/${locked.userId}/lock`).set("Authorization", `Bearer ${admin.accessToken}`).expect(204);

    const res = await http.post("/auth/password-reset/request").send({ email: locked.email }).expect(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(await readLatestMailTo(locked.email)).toBeNull();
  });

  it("silently no-ops for a user in a deactivated tenant", async () => {
    const deactivatedTenant = await createTenant(prisma, `PwReset-Deactivated-${crypto.randomUUID()}`);
    const platformTenant = await createTenant(prisma, `PwReset-Platform-${crypto.randomUUID()}`, "PLATFORM");
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant.id, role: UserRole.PLATFORM_ADMIN, emailPrefix: "reset-deactivate-admin" });
    const target = await createLoggedInUser(app, { tenantId: deactivatedTenant.id, role: UserRole.LOCAL_IT, emailPrefix: "reset-deactivated" });

    await http.post(`/tenants/${deactivatedTenant.id}/deactivate`).set("Authorization", `Bearer ${platformAdmin.accessToken}`).expect(204);

    const res = await http.post("/auth/password-reset/request").send({ email: target.email }).expect(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(await readLatestMailTo(target.email)).toBeNull();
  });

  it("rejects a second redemption of the same token", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "reset-single-use" });
    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const token = extractResetToken((await readLatestMailTo(user.email))!);

    await http.post("/auth/password-reset/confirm").send({ token, newPassword: "FirstNewPassword123!" }).expect(204);

    const secondAttempt = await http
      .post("/auth/password-reset/confirm")
      .send({ token, newPassword: "SecondNewPassword123!" })
      .expect(401);
    expect(secondAttempt.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects a garbage/tampered token", async () => {
    const res = await http
      .post("/auth/password-reset/confirm")
      .send({ token: "not-a-real-jwt", newPassword: "WhateverPassword123!" })
      .expect(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects confirmation for a token whose account was locked after the email was sent", async () => {
    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "reset-postlock-admin" });
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "reset-postlock" });

    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const token = extractResetToken((await readLatestMailTo(user.email))!);

    await http.post(`/users/${user.userId}/lock`).set("Authorization", `Bearer ${admin.accessToken}`).expect(204);

    const res = await http.post("/auth/password-reset/confirm").send({ token, newPassword: "TooLateNow123!" }).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rate limits repeated requests for the same email", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "reset-ratelimit" });
    for (let i = 0; i < 5; i++) {
      await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    }
    const res = await http.post("/auth/password-reset/request").send({ email: user.email }).expect(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
  });

  it("audits both the request and the completion, attributed to the target user's own tenant", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "reset-audit" });
    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const token = extractResetToken((await readLatestMailTo(user.email))!);
    await http.post("/auth/password-reset/confirm").send({ token, newPassword: "TrackedPassword123!" }).expect(204);

    const logs = await prisma.auditLog.findMany({ where: { tenantId, resourceId: user.userId }, orderBy: { seq: "asc" } });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("PASSWORD_RESET_REQUESTED");
    expect(actions).toContain("PASSWORD_RESET_COMPLETED");
  });

  it("rejects a new password containing the account's own last name", async () => {
    // Only POST /users collects names (see CreateUserRequestSchema) -- createLoggedInUser's
    // raw Prisma fixture never sets them, so this is the one path that can actually exercise
    // the personal-info rule against a real firstName/lastName rather than just the
    // email-derived fallback (already covered by the "own last name" case in
    // packages/shared/tests/password-policy.test.ts).
    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "reset-policy-admin" });
    const email = `reset-policy-${crypto.randomUUID()}@test.crop.health`;
    // NURSING, not OPERATOR: CLINIC_ADMIN may only grant NURSING now (see roles.ts).
    await http
      .post("/users")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ email, role: "NURSING", firstName: "Patricia", lastName: "Nunes", clinicTenantIds: [tenantId] })
      .expect(201);

    // Password-reset only ever operates on an *activated* account (see
    // RequestPasswordResetHandler's own `isActivated()` check) -- redeem the invitation
    // first, with an unrelated password, before testing the reset flow itself.
    const inviteToken = extractResetToken((await readLatestMailTo(email))!);
    await http.post("/auth/activate").send({ token: inviteToken, newPassword: "FirstEverPass1$" }).expect(204);

    await http.post("/auth/password-reset/request").send({ email }).expect(200);
    const token = extractResetToken((await readLatestMailTo(email))!);

    const res = await http.post("/auth/password-reset/confirm").send({ token, newPassword: "Nunes12345!" }).expect(400);
    expect(res.body.code).toBe("PASSWORD_POLICY_VIOLATION");
  });

  it("rejects reusing a recent password", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "pwd-history-check" });

    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const firstToken = extractResetToken((await readLatestMailTo(user.email))!);
    await http.post("/auth/password-reset/confirm").send({ token: firstToken, newPassword: "ReusableSecret123!" }).expect(204);

    await http.post("/auth/password-reset/request").send({ email: user.email }).expect(200);
    const secondToken = extractResetToken((await readLatestMailTo(user.email))!);
    const res = await http
      .post("/auth/password-reset/confirm")
      .send({ token: secondToken, newPassword: "ReusableSecret123!" })
      .expect(400);
    expect(res.body.code).toBe("PASSWORD_REUSED");
  });
});
