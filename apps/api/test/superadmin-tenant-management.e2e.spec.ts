import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, clinicPayload } from "./helpers.js";

/**
 * PLATFORM_ADMIN and tenant lifecycle -- the first genuinely cross-tenant capability in this
 * codebase (everything before this either lumps PLATFORM_ADMIN into the same permission list
 * as CLINIC_ADMIN, or scopes every handler to the caller's own tenant with no exception). See
 * docs/architecture.md for the full design rationale, especially why deactivation is a soft
 * `deactivatedAt` flag and never a real DELETE (it would cascade into the append-only
 * audit_logs table, which the whole point of this platform is to never let happen).
 */
describe("Superadmin: tenant lifecycle management", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let platformAdminToken: string;
  let clinicAdminToken: string;
  let clinicTenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const platformTenant = await createTenant(prisma, `Platform-${crypto.randomUUID()}`, "PLATFORM");
    platformAdminToken = (await createLoggedInUser(app, { tenantId: platformTenant.id, role: UserRole.PLATFORM_ADMIN })).accessToken;

    clinicTenantId = (await createTenant(prisma, `Tenants-Clinic-${crypto.randomUUID()}`)).id;
    clinicAdminToken = (await createLoggedInUser(app, { tenantId: clinicTenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("lets a PLATFORM_ADMIN create and list tenants; rejects a CLINIC_ADMIN doing either", async () => {
    const name = `Created-${crypto.randomUUID()}`;
    const createRes = await http
      .post("/tenants")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send(clinicPayload({ name }))
      .expect(201);
    expect(createRes.body.name).toBe(name);
    expect(createRes.body.type).toBe("CLINIC");
    expect(createRes.body.deactivated).toBe(false);

    const listRes = await http.get("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).expect(200);
    expect(listRes.body.some((t: { id: string }) => t.id === createRes.body.id)).toBe(true);

    await http.post("/tenants").set("Authorization", `Bearer ${clinicAdminToken}`).send({ name: "Blocked" }).expect(403);
    await http.get("/tenants").set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
  });

  it("deactivates and reactivates a tenant, actually locking out and restoring its users' ability to log in", async () => {
    const targetTenant = await createTenant(prisma, `Deactivate-Target-${crypto.randomUUID()}`);
    // A clinic-side user, whose *home* tenant is the one being deactivated -- that is what
    // "its users" means here. This used to be an OPERATOR, which only worked while operators
    // lived inside clinic tenants; since the role-model inversion an operator's home tenant
    // is the operating company, so deactivating a clinic correctly leaves their login alone
    // (asserted separately in the next test).
    const target = await createLoggedInUser(app, { tenantId: targetTenant.id, role: UserRole.NURSING, emailPrefix: "tenant-deactivate" });

    await http.post(`/tenants/${targetTenant.id}/deactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);

    const lockedLogin = await http
      .post("/auth/login")
      .send({ email: target.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(403);
    expect(lockedLogin.body.code).toBe("FORBIDDEN");

    // The refresh token issued before deactivation is rejected too, not just fresh logins --
    // mirrors account-lockout.e2e.spec.ts's identical assertion for a locked user.
    const lockedRefresh = await http.post("/auth/refresh").send({ refreshToken: target.refreshToken }).expect(403);
    expect(lockedRefresh.body.code).toBe("FORBIDDEN");

    await http.post(`/tenants/${targetTenant.id}/reactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);

    await http.post("/auth/login").send({ email: target.email, password: "TestPassword123!", clientOs: "MACOS" }).expect(200);
  });

  /**
   * The flip side of the test above, and a genuinely new behaviour introduced by the
   * role-model inversion: deactivating a clinic must NOT disable the operating company's
   * staff, because they are employed elsewhere and serve other clinics. What it must do is
   * cut their access to *that* clinic.
   *
   * Worth pinning down explicitly: "deactivate a clinic" and "lock out the people who
   * operate it" used to be the same action purely because they shared a tenant. Now they are
   * separate, and the boundary between them is exactly the kind of thing that silently
   * regresses into either a lockout of unrelated staff or a clinic that stays reachable after
   * being shut off.
   */
  it("deactivating a clinic cuts a contracted operator's access to it without disabling their account", async () => {
    const clinic = await createTenant(prisma, `Deactivate-Contracted-${crypto.randomUUID()}`);
    const operator = await createContractedOperator(app, prisma, {
      clinicTenantId: clinic.id,
      role: UserRole.OPERATOR,
      emailPrefix: "contracted-operator",
    });

    // Reachable while the contract is live.
    await http.get("/equipment").set("Authorization", `Bearer ${operator.accessToken}`).expect(200);

    await http.post(`/tenants/${clinic.id}/deactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);

    // The account itself still works -- they are not this clinic's employee.
    const stillLoggedIn = await http
      .post("/auth/login")
      .send({ email: operator.email, password: "TestPassword123!", clientOs: "MACOS" })
      .expect(200);
    expect(stillLoggedIn.body.mfaToken).toBeTruthy();

    // But they can no longer obtain a token scoped to the deactivated clinic.
    const refused = await http
      .post("/auth/active-clinic")
      .set("Authorization", `Bearer ${operator.accessToken}`)
      .send({ clinicTenantId: clinic.id })
      .expect(403);
    expect(refused.body.code).toBe("FORBIDDEN");
  });

  it("rejects a CLINIC_ADMIN trying to deactivate or reactivate any tenant", async () => {
    const targetTenant = await createTenant(prisma, `Deactivate-RBAC-${crypto.randomUUID()}`);
    await http.post(`/tenants/${targetTenant.id}/deactivate`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
  });

  it("refuses to deactivate a PLATFORM-type tenant, to prevent a superadmin locking out every platform admin at once", async () => {
    const platformTenant = await createTenant(prisma, `Platform-Guard-${crypto.randomUUID()}`, "PLATFORM");
    const res = await http
      .post(`/tenants/${platformTenant.id}/deactivate`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("lets a PLATFORM_ADMIN create a user inside a tenant that isn't their own", async () => {
    const email = `cross-tenant-${crypto.randomUUID()}@test.crop.health`;
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ email, role: "CLINIC_ADMIN", clinicTenantIds: [clinicTenantId], firstName: "Marina", lastName: "Ferreira" })
      .expect(201);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.tenantId).toBe(clinicTenantId);
    expect(created.role).toBe("CLINIC_ADMIN");
  });

  it("ignores a CLINIC_ADMIN-supplied tenantId -- not a privilege escalation path to plant a user in someone else's tenant", async () => {
    const otherTenantId = (await createTenant(prisma, `Escalation-Target-${crypto.randomUUID()}`)).id;
    const email = `escalation-attempt-${crypto.randomUUID()}@test.crop.health`;

    // NURSING, not OPERATOR: CLINIC_ADMIN may only grant NURSING now (see roles.ts).
    // `tenantId` (the legacy single-tenant field) points at a tenant this caller has
    // nothing to do with; `clinicTenantIds` is their own -- the assertion is that the
    // legacy field is ignored, not that the request fails outright.
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ email, role: "NURSING", tenantId: otherTenantId, clinicTenantIds: [clinicTenantId], firstName: "Escalation", lastName: "Attempt" })
      .expect(201);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.tenantId).toBe(clinicTenantId); // the CLINIC_ADMIN's own tenant, not otherTenantId
    expect(created.tenantId).not.toBe(otherTenantId);
  });

  it("rejects a CLINIC_ADMIN listing a clinicTenantId they don't themselves belong to", async () => {
    const otherTenantId = (await createTenant(prisma, `Escalation-Clinic-${crypto.randomUUID()}`)).id;
    const email = `escalation-clinic-${crypto.randomUUID()}@test.crop.health`;

    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ email, role: "NURSING", clinicTenantIds: [otherTenantId], firstName: "Escalation", lastName: "Clinic" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("still refuses to create a PLATFORM_ADMIN through POST /users, even for a PLATFORM_ADMIN caller", async () => {
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({
        email: `self-escalation-${crypto.randomUUID()}@test.crop.health`,
        password: "Whatever123!",
        role: "PLATFORM_ADMIN",
        tenantId: clinicTenantId,
        firstName: "Self",
        lastName: "Escalation",
      })
      .expect(400);
    expect(res.body.message).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["role"] })]));
  });

  it("audits tenant creation, deactivation, and reactivation, and user creation, all attributed to the affected tenant", async () => {
    const name = `Audited-${crypto.randomUUID()}`;
    const createRes = await http
      .post("/tenants")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send(clinicPayload({ name }))
      .expect(201);
    const tenantId = createRes.body.id;

    await http.post(`/tenants/${tenantId}/deactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);
    await http.post(`/tenants/${tenantId}/reactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);

    const logs = await prisma.auditLog.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("TENANT_CREATED");
    expect(actions).toContain("TENANT_DEACTIVATED");
    expect(actions).toContain("TENANT_REACTIVATED");

    // LOCAL_IT, not OPERATOR: `tenantId` here is a CLINIC (see clinicPayload above), and
    // operator-side roles are OPERATOR_PROVIDER-only since the role-model inversion (see
    // packages/shared/src/roles.ts), so RegisterUserHandler would now correctly reject an
    // OPERATOR here. This test is about audit attribution following the affected tenant, not
    // about roles -- LOCAL_IT is the minimal substitution that keeps it so: it is valid in a
    // CLINIC and, unlike NURSING/CLINIC_ADMIN/LOCAL_SUPERVISOR, needs no `clinicTenantIds`
    // (see requiresClinicAssignment), so the request body stays exactly as narrow as before.
    const userRes = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ email: `audited-user-${crypto.randomUUID()}@test.crop.health`, password: "Whatever123!", role: "LOCAL_IT", tenantId, firstName: "Audited", lastName: "User" })
      .expect(201);

    const userLogs = await prisma.auditLog.findMany({ where: { tenantId, resourceId: userRes.body.userId } });
    expect(userLogs.some((l) => l.action === "USER_CREATED")).toBe(true);
  });
});
