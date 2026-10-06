import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * `PATCH /users/:id` -- the gap found alongside the operadora/contract work: an admin could
 * create, lock/unlock, and reset a user's password, but never *edit* one (name, role, or
 * which clinics they reach) short of locking the account and creating a replacement. This
 * covers the handler's own two-sided permission check (`UpdateUserHandler`'s own docstring):
 * the acting admin must be able to grant *both* the user's current role and the requested
 * one, not just the destination -- otherwise a LOCAL_SUPERVISOR could use "just editing the
 * name" as a backdoor into an account they have no authority over, or use a role change to
 * demote a peer they could never have created in the first place.
 */
describe("Admin user management: editing", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;
  let otherTenantId: string;
  let platformTenantId: string;
  let adminUser: Awaited<ReturnType<typeof createLoggedInUser>>;
  let platformAdminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    tenantId = (await createTenant(prisma, `EditUsers-${crypto.randomUUID()}`)).id;
    otherTenantId = (await createTenant(prisma, `EditUsersOther-${crypto.randomUUID()}`)).id;
    platformTenantId = (await createTenant(prisma, `EditUsersPlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    adminUser = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "edit-admin" });
    platformAdminToken = (await createLoggedInUser(app, { tenantId: platformTenantId, role: UserRole.PLATFORM_ADMIN, emailPrefix: "edit-platform-admin" }))
      .accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function createNurse(overrides: Record<string, unknown> = {}) {
    const email = `edit-nurse-${crypto.randomUUID()}@test.crop.health`;
    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${adminUser.accessToken}`)
      .send({ email, role: "NURSING", firstName: "Enfermeira", lastName: "Original", clinicTenantIds: [tenantId], ...overrides })
      .expect(201);
    return res.body.userId as string;
  }

  it("updates personal fields without touching role or email", async () => {
    const userId = await createNurse();
    const res = await http
      .patch(`/users/${userId}`)
      .set("Authorization", `Bearer ${adminUser.accessToken}`)
      .send({ firstName: "Renomeada", lastName: "Sobrenome", professionalRegistration: "COREN-SP 999999", email: "ignored@test.crop.health" })
      .expect(200);
    expect(res.body.firstName).toBe("Renomeada");
    expect(res.body.lastName).toBe("Sobrenome");
    expect(res.body.professionalRegistration).toBe("COREN-SP 999999");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.firstName).toBe("Renomeada");
    // email was in the body but UpdateUserRequestSchema has no such field -- zod strips it
    // silently rather than erroring, the same "deliberately absent" contract its own
    // docstring describes.
    expect(row.email).not.toBe("ignored@test.crop.health");
  });

  it("clears professionalRegistration with an explicit null, same asymmetry as other optional-at-creation fields", async () => {
    const userId = await createNurse({ professionalRegistration: "COREN-SP 111111" });
    const res = await http.patch(`/users/${userId}`).set("Authorization", `Bearer ${adminUser.accessToken}`).send({ professionalRegistration: null }).expect(200);
    expect(res.body.professionalRegistration).toBeNull();
  });

  it("lets a CLINIC_ADMIN change a NURSING user's role to LOCAL_IT -- both roles are within what CLINIC_ADMIN may grant", async () => {
    const userId = await createNurse();
    const res = await http.patch(`/users/${userId}`).set("Authorization", `Bearer ${adminUser.accessToken}`).send({ role: "LOCAL_IT" }).expect(200);
    expect(res.body.role).toBe("LOCAL_IT");
  });

  it("rejects a LOCAL_SUPERVISOR editing a CLINIC_ADMIN account at all, even just the name -- the current-role check, not only the destination", async () => {
    const supervisor = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_SUPERVISOR, emailPrefix: "edit-supervisor" });
    const clinicAdminTarget = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "edit-target-admin" });
    const res = await http
      .patch(`/users/${clinicAdminTarget.userId}`)
      .set("Authorization", `Bearer ${supervisor.accessToken}`)
      .send({ firstName: "Should Not Apply" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rejects a LOCAL_SUPERVISOR promoting a NURSING user to CLINIC_ADMIN -- the destination-role check", async () => {
    const supervisor = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_SUPERVISOR, emailPrefix: "edit-supervisor-promote" });
    const userId = await createNurse();
    const res = await http
      .patch(`/users/${userId}`)
      .set("Authorization", `Bearer ${supervisor.accessToken}`)
      .send({ role: "CLINIC_ADMIN" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    // Unchanged -- the rejected attempt had no partial effect.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.role).toBe("NURSING");
  });

  it("rejects editing a user who belongs to a different tenant, same isolation lock/unlock already enforce", async () => {
    const otherUser = await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "edit-cross-tenant" });
    await http.patch(`/users/${otherUser.userId}`).set("Authorization", `Bearer ${adminUser.accessToken}`).send({ firstName: "Nope" }).expect(403);
  });

  it("404s for a user that doesn't exist", async () => {
    await http.patch("/users/00000000-0000-0000-0000-000000000000").set("Authorization", `Bearer ${adminUser.accessToken}`).send({ firstName: "Nope" }).expect(404);
  });

  it("replaces clinicTenantIds wholesale, scoped to clinics the acting admin already belongs to", async () => {
    const secondClinicId = (await createTenant(prisma, `EditUsersSecondClinic-${crypto.randomUUID()}`)).id;
    // Test setup only, via Prisma directly: the acting admin needs to already belong to
    // the second clinic for the actor-scope check below to let them link it to someone
    // else -- the API itself has no self-service "join another clinic" path (by design,
    // the same chicken-and-egg this check exists to prevent).
    await prisma.userClinicMembership.create({ data: { userId: adminUser.userId, clinicTenantId: secondClinicId } });

    const userId = await createNurse();
    const res = await http
      .patch(`/users/${userId}`)
      .set("Authorization", `Bearer ${adminUser.accessToken}`)
      .send({ clinicTenantIds: [secondClinicId] })
      .expect(200);
    // Home tenant is always force-included, same convention RegisterUserCommand's own
    // clinicTenantIds already uses -- sending just the "extra" clinic still yields both.
    expect(new Set(res.body.clinicTenantIds)).toEqual(new Set([tenantId, secondClinicId]));
  });

  it("rejects a non-PLATFORM_ADMIN linking a clinic they don't themselves belong to", async () => {
    const unrelatedClinicId = (await createTenant(prisma, `EditUsersUnrelated-${crypto.randomUUID()}`)).id;
    const userId = await createNurse();
    const res = await http
      .patch(`/users/${userId}`)
      .set("Authorization", `Bearer ${adminUser.accessToken}`)
      .send({ clinicTenantIds: [unrelatedClinicId] })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rejects changing a role away from CLINIC_ADMIN while the user is still some tenant's responsible manager", async () => {
    const clinicAdmin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "edit-fk-guard" });
    await http
      .patch(`/tenants/${tenantId}`)
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ responsibleManagerId: clinicAdmin.userId })
      .expect(200);

    const res = await http
      .patch(`/users/${clinicAdmin.userId}`)
      .set("Authorization", `Bearer ${adminUser.accessToken}`)
      .send({ role: "LOCAL_SUPERVISOR" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    // Unassigning first, then the same role change succeeds.
    await http.patch(`/tenants/${tenantId}`).set("Authorization", `Bearer ${platformAdminToken}`).send({ responsibleManagerId: null }).expect(200);
    await http.patch(`/users/${clinicAdmin.userId}`).set("Authorization", `Bearer ${adminUser.accessToken}`).send({ role: "LOCAL_SUPERVISOR" }).expect(200);
  });

  it("rejects a non-admin editing any user", async () => {
    const nurse = await createLoggedInUser(app, { tenantId, role: UserRole.NURSING, emailPrefix: "edit-rbac-nurse" });
    const other = await createNurse();
    await http.patch(`/users/${other}`).set("Authorization", `Bearer ${nurse.accessToken}`).send({ firstName: "Blocked" }).expect(403);
  });

  it("audits the edit under USER_UPDATED, attributed to the acting admin and the affected tenant", async () => {
    const userId = await createNurse();
    await http.patch(`/users/${userId}`).set("Authorization", `Bearer ${adminUser.accessToken}`).send({ lastName: "Audited" }).expect(200);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: userId, action: "USER_UPDATED" } });
    expect(log.tenantId).toBe(tenantId);
    expect((log.details as { changedFields?: string[] }).changedFields).toEqual(["lastName"]);
  });
});
