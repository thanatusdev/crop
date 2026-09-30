import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import * as OTPAuth from "otpauth";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, equipmentPayload, extractResetToken, readLatestMailTo } from "./helpers.js";

/**
 * The business rule this whole feature is built around:
 *   "A Manager is linked to one or more clinics. A Supervisor is linked to the clinic(s)
 *   of the responsible Manager. The Clinic Manager registers users with the Nursing
 *   profile."
 * Covers the parts of that not already exercised by admin-user-management.e2e.spec.ts
 * (basic create/list) or superadmin-tenant-management.e2e.spec.ts (the tenantId
 * escalation checks): multi-clinic membership itself, rule 2's "already has a Manager"
 * enforcement, and the active-clinic switch that makes a multi-clinic account usable.
 */
describe("Clinic membership and the Manager/Supervisor/Nursing registration rules", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let clinicA: string;
  let clinicB: string;
  let clinicC: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    clinicA = (await createTenant(prisma, `RuleClinicA-${crypto.randomUUID()}`)).id;
    clinicB = (await createTenant(prisma, `RuleClinicB-${crypto.randomUUID()}`)).id;
    clinicC = (await createTenant(prisma, `RuleClinicC-${crypto.randomUUID()}`)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("registers a Manager linked to more than one clinic, with the first id as their home tenant", async () => {
    const platformTenant = (await createTenant(prisma, `RulePlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN });

    const email = `multi-manager-${crypto.randomUUID()}@test.crop.health`;
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send({ email, role: "CLINIC_ADMIN", firstName: "Multi", lastName: "Clinic", clinicTenantIds: [clinicA, clinicB] })
      .expect(201);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId }, include: { clinicMemberships: true } });
    expect(created.tenantId).toBe(clinicA); // home = first entry
    expect(created.clinicMemberships.map((m) => m.clinicTenantId).sort()).toEqual([clinicA, clinicB].sort());
  });

  it("rejects linking a Supervisor to a clinic that has no Clinic Manager yet", async () => {
    const platformTenant = (await createTenant(prisma, `RulePlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN });

    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send({ email: `orphan-supervisor-${crypto.randomUUID()}@test.crop.health`, role: "LOCAL_SUPERVISOR", firstName: "Orphan", lastName: "Supervisor", clinicTenantIds: [clinicC] })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("lets a Supervisor be linked once the clinic has a Clinic Manager, lets a CLINIC_ADMIN register one, and stops a LOCAL_SUPERVISOR registering a peer", async () => {
    const platformTenant = (await createTenant(prisma, `RulePlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN });

    // First, give clinicC a Manager.
    const managerEmail = `manager-for-c-${crypto.randomUUID()}@test.crop.health`;
    await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send({ email: managerEmail, role: "CLINIC_ADMIN", firstName: "Clinic", lastName: "Manager", clinicTenantIds: [clinicC] })
      .expect(201);

    // Now a Supervisor can be linked to clinicC.
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send({ email: `supervisor-for-c-${crypto.randomUUID()}@test.crop.health`, role: "LOCAL_SUPERVISOR", firstName: "Real", lastName: "Supervisor", clinicTenantIds: [clinicC] })
      .expect(201);
    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.role).toBe("LOCAL_SUPERVISOR");

    // A CLINIC_ADMIN now MAY register a Supervisor -- the clinic-side rule is "the Manager
    // can do everything" (ROLE_GRANTS[CLINIC_ADMIN] covers all four clinic roles). This
    // assertion used to be the exact opposite; see roles.ts for why it was widened.
    const managerLogin = await createLoggedInUser(app, { tenantId: clinicC, role: UserRole.CLINIC_ADMIN, emailPrefix: "manager-acting" });
    const byManager = await http
      .post("/users")
      .set("Authorization", `Bearer ${managerLogin.accessToken}`)
      .send({ email: `sup-by-manager-${crypto.randomUUID()}@test.crop.health`, role: "LOCAL_SUPERVISOR", firstName: "Second", lastName: "Supervisor", clinicTenantIds: [clinicC] })
      .expect(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: byManager.body.userId } })).role).toBe("LOCAL_SUPERVISOR");

    // The line the widening deliberately did NOT cross: a LOCAL_SUPERVISOR may staff the
    // clinic (NURSING, LOCAL_IT) but may never appoint a peer or a manager. This is the
    // precise difference between the two privileged clinic roles, so both halves are
    // asserted -- a supervisor who could create neither would pass a "rejects a peer" test
    // for the wrong reason.
    const supervisorLogin = await createLoggedInUser(app, { tenantId: clinicC, role: UserRole.LOCAL_SUPERVISOR, emailPrefix: "supervisor-acting" });
    const nurseBySupervisor = await http
      .post("/users")
      .set("Authorization", `Bearer ${supervisorLogin.accessToken}`)
      .send({ email: `nurse-by-sup-${crypto.randomUUID()}@test.crop.health`, role: "NURSING", firstName: "Staffed", lastName: "Nurse", clinicTenantIds: [clinicC] })
      .expect(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: nurseBySupervisor.body.userId } })).role).toBe("NURSING");

    for (const role of ["LOCAL_SUPERVISOR", "CLINIC_ADMIN"]) {
      const forbidden = await http
        .post("/users")
        .set("Authorization", `Bearer ${supervisorLogin.accessToken}`)
        .send({ email: `nope-${crypto.randomUUID()}@test.crop.health`, role, firstName: "No", lastName: "Way", clinicTenantIds: [clinicC] })
        .expect(403);
      expect(forbidden.body.code).toBe("FORBIDDEN");
    }
  });

  it("lets a multi-clinic Manager switch their active clinic, and every existing tenant-scoped check follows the new active clinic", async () => {
    const platformTenant = (await createTenant(prisma, `RulePlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN });

    const email = `switcher-${crypto.randomUUID()}@test.crop.health`;
    await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send({ email, role: "CLINIC_ADMIN", firstName: "Switcher", lastName: "Manager", clinicTenantIds: [clinicA, clinicB] })
      .expect(201);

    // A user whose *home* is clinicB, so "GET /users scoped to clinicB" has something real
    // to find once the switch below happens.
    await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send({ email: `nurse-in-b-${crypto.randomUUID()}@test.crop.health`, role: "NURSING", firstName: "Nurse", lastName: "InB", clinicTenantIds: [clinicB] })
      .expect(201);

    // Equipment of clinicB's own, for the identical reason -- and specifically the regression
    // this test now guards against. `OperatorAccessService.isCrossTenantActor` once read only
    // `homeTenantId !== tenantId`, true for this switch too even though it is a plain
    // `UserClinicMembership` relationship with no `OperatorAgreement` anywhere near it -- so
    // `GET /equipment` came back empty for a real, legitimate multi-clinic Manager the moment
    // they switched, in a codebase that had no frontend caller of the switch endpoint to ever
    // exercise this until `WorkstationPage` grew a clinic step. Found live, not by review; see
    // that service's own docstring for the fix.
    const clinicBAdmin = await createLoggedInUser(app, { tenantId: clinicB, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinicb-admin" });
    await http
      .post("/equipment")
      .set("Authorization", `Bearer ${clinicBAdmin.accessToken}`)
      .send(equipmentPayload({ name: "Switcher-ClinicB-Equipment" }))
      .expect(201);

    // Activate the account so it can actually log in.
    const token = extractResetToken((await readLatestMailTo(email))!);
    await http.post("/auth/activate").send({ token, newPassword: "Xk9!qLp7zM2" }).expect(204);

    const prismaUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    // First-ever login enrolls MFA (mfaEnabledAt is still null right after activation --
    // only ConfirmMfaEnrollmentCommand sets it).
    const firstLogin = await http.post("/auth/login").send({ email, password: "Xk9!qLp7zM2", clientOs: "MACOS" }).expect(200);
    expect(firstLogin.body.status).toBe("mfa_enrollment_required");
    const enrollCode = new OTPAuth.TOTP({ secret: prismaUser.mfaSecret! }).generate();
    await http.post("/auth/mfa/enroll/confirm").send({ enrollmentToken: firstLogin.body.enrollmentToken, code: enrollCode }).expect(204);

    const loginRes = await http.post("/auth/login").send({ email, password: "Xk9!qLp7zM2", clientOs: "MACOS" }).expect(200);
    const code = new OTPAuth.TOTP({ secret: prismaUser.mfaSecret! }).generate();
    const verifyRes = await http.post("/auth/mfa/verify").send({ mfaToken: loginRes.body.mfaToken, code }).expect(200);
    const accessToken = verifyRes.body.accessToken as string;

    const clinicsRes = await http.get("/auth/me/clinics").set("Authorization", `Bearer ${accessToken}`).expect(200);
    expect(clinicsRes.body.map((c: { id: string }) => c.id).sort()).toEqual([clinicA, clinicB].sort());
    expect(clinicsRes.body.find((c: { id: string }) => c.id === clinicA).active).toBe(true);

    // GET /users right now is scoped to clinicA (the active/home clinic).
    const usersInA = await http.get("/users").set("Authorization", `Bearer ${accessToken}`).expect(200);
    expect(usersInA.body.every((u: { tenantId: string }) => u.tenantId === clinicA)).toBe(true);

    // Switch to clinicB -- a fresh token pair scoped to clinicB.
    const switchRes = await http
      .post("/auth/active-clinic")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ clinicTenantId: clinicB })
      .expect(200);
    const bAccessToken = switchRes.body.accessToken as string;

    const usersInB = await http.get("/users").set("Authorization", `Bearer ${bAccessToken}`).expect(200);
    expect(usersInB.body.length).toBeGreaterThan(0);
    expect(usersInB.body.every((u: { tenantId: string }) => u.tenantId === clinicB)).toBe(true);

    // The regression itself: a plain multi-clinic Manager, switched into a clinic they hold
    // real membership in, must see that clinic's equipment in full -- not narrowed by
    // OperatorAccessService, which has no business here at all (there is no OperatorAgreement
    // between two CLINIC tenants; membership is ClinicAccessChecker's own concern).
    const equipmentInB = await http.get("/equipment").set("Authorization", `Bearer ${bAccessToken}`).expect(200);
    expect(equipmentInB.body.map((e: { name: string }) => e.name)).toContain("Switcher-ClinicB-Equipment");

    // Rejects switching to a clinic this account has no membership in.
    const notMine = await http
      .post("/auth/active-clinic")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ clinicTenantId: clinicC })
      .expect(403);
    expect(notMine.body.code).toBe("FORBIDDEN");
  });
});
