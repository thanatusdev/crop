import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import * as OTPAuth from "otpauth";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, readLatestMailTo, extractResetToken } from "./helpers.js";

/**
 * Password history (reuse prevention) and rotation (expiry + the forced in-band change) --
 * see docs/architecture.md. Deliberately a separate file from password-reset.e2e.spec.ts:
 * that one is the email-link flow; this one is what happens at login once a password is
 * either too old or was never chosen by the user themselves (registration, admin reset).
 *
 * `createLoggedInUser` (helpers.ts) drives the real HTTP login+MFA flow, but its fixture
 * rows get `mustChangePassword: false` / a fresh `passwordChangedAt` from the schema's own
 * column defaults -- neither forced-change condition is true for a fixture built that way,
 * which is exactly why every other e2e file in this suite can keep using it unmodified. The
 * tests below deliberately override one of those two columns by hand (direct Prisma) or by
 * going through a real admin-reset/registration call, to actually exercise the branch.
 */
describe("Password history and rotation", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    tenantId = (await createTenant(prisma, `PwRotation-${crypto.randomUUID()}`)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  /** Logs a fixture user in through the real HTTP flow, up to and including MFA -- returns
   * whatever `/auth/mfa/verify` actually responded with, unlike `createLoggedInUser` (which
   * assumes success and would throw trying to decode a non-existent accessToken). */
  async function loginAndVerify(email: string, password: string, code: string) {
    const loginRes = await http.post("/auth/login").send({ email, password, clientOs: "MACOS" }).expect(200);
    return http.post("/auth/mfa/verify").send({ mfaToken: loginRes.body.mfaToken, code }).expect(200);
  }

  it("forces a change when the password is older than PASSWORD_MAX_AGE_DAYS, and the change mints real tokens and kills the old refresh token", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "rotation-expired" });

    // Simulate a password set 91 days ago (default PASSWORD_MAX_AGE_DAYS is 90) -- direct
    // Prisma, since there's no HTTP path that lets a test backdate this column.
    await prisma.user.update({
      where: { id: user.userId },
      data: { passwordChangedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
    });

    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaSecret!;
    const code = new OTPAuth.TOTP({ secret }).generate();
    const verifyRes = await loginAndVerify(user.email, "TestPassword123!", code);

    expect(verifyRes.body.status).toBe("password_change_required");
    expect(verifyRes.body.reason).toBe("expired");
    expect(verifyRes.body.email).toBe(user.email);
    expect(verifyRes.body).not.toHaveProperty("accessToken");

    const changeRes = await http
      .post("/auth/password-change")
      .send({ changeToken: verifyRes.body.changeToken, newPassword: "FreshRotated456!" })
      .expect(200);
    expect(changeRes.body.accessToken).toBeTruthy();
    expect(changeRes.body.refreshToken).toBeTruthy();

    // The refresh token from createLoggedInUser's own original login predates the change --
    // setPassword's unconditional session revocation must have killed it.
    const oldRefresh = await http.post("/auth/refresh").send({ refreshToken: user.refreshToken }).expect(401);
    expect(oldRefresh.body.code).toBe("UNAUTHORIZED");

    // The new password actually works, end to end, on a normal subsequent login.
    const secondLogin = await loginAndVerify(user.email, "FreshRotated456!", new OTPAuth.TOTP({ secret }).generate());
    expect(secondLogin.body.status).toBe("ok");
  });

  it("never forces a change for a freshly-invited account -- the user chose this password themselves on activation", async () => {
    // Superseded scenario: POST /users used to set an admin-issued temp password directly
    // (mustChangePassword: true), forcing a change on first login. It no longer sets a
    // password at all -- it sends a secure invitation link (see SendInvitationHandler),
    // and ActivateAccountHandler always leaves mustChangePassword false, because by
    // definition nobody but the new user themselves ever typed this one in.
    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "rotation-new-admin" });
    const email = `rotation-newhire-${crypto.randomUUID()}@test.crop.health`;
    const password = "OwnChoiceFresh1$";

    const createRes = await http
      .post("/users")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ email, role: "NURSING", firstName: "Onboard", lastName: "Hire", clinicTenantIds: [tenantId] })
      .expect(201);

    const inviteToken = extractResetToken((await readLatestMailTo(email))!);
    await http.post("/auth/activate").send({ token: inviteToken, newPassword: password }).expect(204);

    // First-ever login: enrolls MFA, exactly like the pre-existing enrollment flow.
    const firstLogin = await http.post("/auth/login").send({ email, password, clientOs: "MACOS" }).expect(200);
    expect(firstLogin.body.status).toBe("mfa_enrollment_required");
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: createRes.body.userId } })).mfaSecret!;
    const enrollCode = new OTPAuth.TOTP({ secret }).generate();
    await http.post("/auth/mfa/enroll/confirm").send({ enrollmentToken: firstLogin.body.enrollmentToken, code: enrollCode }).expect(204);

    // Second login: MFA is now enrolled, so this reaches VerifyMfaHandler -- and this is
    // where the old admin-issued-temp-password scenario would have forced a change. It
    // doesn't, because this password was never anyone's but the new user's own choice.
    const verifyRes = await loginAndVerify(email, password, new OTPAuth.TOTP({ secret }).generate());
    expect(verifyRes.body.status).toBe("ok");
  });

  it("forces a change after an admin-driven reset (reason: must_change), and the admin's own new password is subject to the same policy/reuse rules", async () => {
    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "rotation-reset-admin" });
    const target = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "rotation-reset-target" });

    await http
      .post(`/users/${target.userId}/reset-password`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ newPassword: "AdminChosen234!" })
      .expect(204);

    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).mfaSecret!;
    const verifyRes = await loginAndVerify(target.email, "AdminChosen234!", new OTPAuth.TOTP({ secret }).generate());
    expect(verifyRes.body.status).toBe("password_change_required");
    expect(verifyRes.body.reason).toBe("must_change");

    // The old refresh token, issued before the admin reset, is dead -- AdminResetPasswordHandler
    // now revokes sessions too (see its own docstring on why that reversed).
    const oldRefresh = await http.post("/auth/refresh").send({ refreshToken: target.refreshToken }).expect(401);
    expect(oldRefresh.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects reusing a recent password through the change endpoint, same as the reset endpoint", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "rotation-reuse" });
    // createLoggedInUser bypasses UserRepositoryPort.create (raw Prisma -- see its own
    // docstring on why), so unlike a real registration, this fixture's current password was
    // never inserted into password_history. An account whose current password isn't its own
    // most recent history entry can only happen through this test-only shortcut, never
    // through any real code path (RegisterUserHandler's `create()` and every
    // `setPassword()` call both insert a history row in the same transaction as the write
    // they accompany) -- compensating for the shortcut here, not "fixing" the helper.
    const currentHash = (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).passwordHash;
    await prisma.passwordHistory.create({ data: { userId: user.userId, passwordHash: currentHash } });

    await prisma.user.update({
      where: { id: user.userId },
      data: { passwordChangedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
    });
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaSecret!;

    const verifyRes = await loginAndVerify(user.email, "TestPassword123!", new OTPAuth.TOTP({ secret }).generate());
    const res = await http
      .post("/auth/password-change")
      .send({ changeToken: verifyRes.body.changeToken, newPassword: "TestPassword123!" }) // the CURRENT password
      .expect(400);
    expect(res.body.code).toBe("PASSWORD_REUSED");
  });

  it("rejects a second redemption of the same change token", async () => {
    const user = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "rotation-single-use" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { passwordChangedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
    });
    const secret = (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaSecret!;

    const verifyRes = await loginAndVerify(user.email, "TestPassword123!", new OTPAuth.TOTP({ secret }).generate());
    await http
      .post("/auth/password-change")
      .send({ changeToken: verifyRes.body.changeToken, newPassword: "OnlyOnceWorks123!" })
      .expect(200);

    const secondAttempt = await http
      .post("/auth/password-change")
      .send({ changeToken: verifyRes.body.changeToken, newPassword: "AnotherAttempt456!" })
      .expect(401);
    expect(secondAttempt.body.code).toBe("UNAUTHORIZED");
  });
});
