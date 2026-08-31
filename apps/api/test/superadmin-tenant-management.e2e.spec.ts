import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

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
    const createRes = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send({ name }).expect(201);
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
    const target = await createLoggedInUser(app, { tenantId: targetTenant.id, role: UserRole.OPERATOR, emailPrefix: "tenant-deactivate" });

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
      .send({ email, password: "CrossTenant123!", role: "CLINIC_ADMIN", tenantId: clinicTenantId })
      .expect(201);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.tenantId).toBe(clinicTenantId);
    expect(created.role).toBe("CLINIC_ADMIN");
  });

  it("ignores a CLINIC_ADMIN-supplied tenantId -- not a privilege escalation path to plant a user in someone else's tenant", async () => {
    const otherTenantId = (await createTenant(prisma, `Escalation-Target-${crypto.randomUUID()}`)).id;
    const email = `escalation-attempt-${crypto.randomUUID()}@test.crop.health`;

    const res = await http
      .post("/users")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ email, password: "Whatever123!", role: "OPERATOR", tenantId: otherTenantId })
      .expect(201);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.tenantId).toBe(clinicTenantId); // the CLINIC_ADMIN's own tenant, not otherTenantId
    expect(created.tenantId).not.toBe(otherTenantId);
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
      })
      .expect(400);
    expect(res.body.message).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["role"] })]));
  });

  it("audits tenant creation, deactivation, and reactivation, and user creation, all attributed to the affected tenant", async () => {
    const name = `Audited-${crypto.randomUUID()}`;
    const createRes = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send({ name }).expect(201);
    const tenantId = createRes.body.id;

    await http.post(`/tenants/${tenantId}/deactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);
    await http.post(`/tenants/${tenantId}/reactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);

    const logs = await prisma.auditLog.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("TENANT_CREATED");
    expect(actions).toContain("TENANT_DEACTIVATED");
    expect(actions).toContain("TENANT_REACTIVATED");

    const userRes = await http
      .post("/users")
      .set("Authorization", `Bearer ${platformAdminToken}`)
      .send({ email: `audited-user-${crypto.randomUUID()}@test.crop.health`, password: "Whatever123!", role: "OPERATOR", tenantId })
      .expect(201);

    const userLogs = await prisma.auditLog.findMany({ where: { tenantId, resourceId: userRes.body.userId } });
    expect(userLogs.some((l) => l.action === "USER_CREATED")).toBe(true);
  });
});
