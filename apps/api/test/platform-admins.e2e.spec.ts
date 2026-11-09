import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, readLatestMailTo, type TestUser } from "./helpers.js";

/**
 * `POST /platform/admins` and the lock rules that keep a platform from ending up with no
 * administrator: only a PLATFORM_ADMIN may create one, nobody may lock themselves, and the
 * last platform admin able to sign in cannot be locked.
 */
describe("Platform admins", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let platformTenantId: string;
  let firstAdmin: TestUser;
  let clinicAdminToken: string;
  let operatorAdminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    platformTenantId = (await createTenant(prisma, `Platform-${crypto.randomUUID()}`, "PLATFORM")).id;
    firstAdmin = await createLoggedInUser(app, { tenantId: platformTenantId, role: UserRole.PLATFORM_ADMIN, emailPrefix: "first-admin" });

    const clinicTenantId = (await createTenant(prisma, `PA-Clinic-${crypto.randomUUID()}`)).id;
    clinicAdminToken = (await createLoggedInUser(app, { tenantId: clinicTenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
    const operatorTenantId = (await createTenant(prisma, `PA-Operator-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    operatorAdminToken = (await createLoggedInUser(app, { tenantId: operatorTenantId, role: UserRole.OPERATOR_ADMIN })).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("lets a platform admin invite another one into its own PLATFORM tenant", async () => {
    const email = `invited-admin-${crypto.randomUUID()}@test.crop.health`;
    const res = await http
      .post("/platform/admins")
      .set("Authorization", `Bearer ${firstAdmin.accessToken}`)
      .send({ email, firstName: "Segunda", lastName: "Admin" })
      .expect(201);

    const created = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    expect(created.role).toBe("PLATFORM_ADMIN");
    expect(created.tenantId).toBe(platformTenantId);
    // Onboarded through the invitation link like every HTTP-created account, never active yet.
    expect(created.activatedAt).toBeNull();
    expect(await readLatestMailTo(email)).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { tenantId: platformTenantId, action: "USER_CREATED", resourceId: created.id } });
    expect(audit?.userId).toBe(firstAdmin.userId);

    const list = await http.get("/platform/admins").set("Authorization", `Bearer ${firstAdmin.accessToken}`).expect(200);
    const ids = list.body.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([firstAdmin.userId, created.id]));
  });

  it("refuses everyone who is not a platform admin", async () => {
    const body = { email: `nope-${crypto.randomUUID()}@test.crop.health`, firstName: "No", lastName: "Pe" };
    await http.post("/platform/admins").set("Authorization", `Bearer ${clinicAdminToken}`).send(body).expect(403);
    await http.post("/platform/admins").set("Authorization", `Bearer ${operatorAdminToken}`).send(body).expect(403);
    await http.get("/platform/admins").set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
  });

  it("still refuses PLATFORM_ADMIN through POST /users, even from a platform admin", async () => {
    await http
      .post("/users")
      .set("Authorization", `Bearer ${firstAdmin.accessToken}`)
      .send({ email: `via-users-${crypto.randomUUID()}@test.crop.health`, role: "PLATFORM_ADMIN", firstName: "Via", lastName: "Users" })
      .expect(400);
  });

  it("never lets anyone lock their own account", async () => {
    await http.post(`/users/${firstAdmin.userId}/lock`).set("Authorization", `Bearer ${firstAdmin.accessToken}`).expect(403);
  });

  it("refuses to lock the last platform admin able to sign in, and allows it while another one remains", async () => {
    const tenantId = (await createTenant(prisma, `Platform-Last-${crypto.randomUUID()}`, "PLATFORM")).id;
    const a = await createLoggedInUser(app, { tenantId, role: UserRole.PLATFORM_ADMIN, emailPrefix: "last-a" });
    const b = await createLoggedInUser(app, { tenantId, role: UserRole.PLATFORM_ADMIN, emailPrefix: "last-b" });

    // Two active admins: A may lock B.
    await http.post(`/users/${b.userId}/lock`).set("Authorization", `Bearer ${a.accessToken}`).expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).lockedAt).not.toBeNull();
    await http.post(`/users/${b.userId}/unlock`).set("Authorization", `Bearer ${a.accessToken}`).expect(204);

    // B locks A. A's access token stays valid until it expires, but B is now the only active
    // admin left, so A must not be able to lock B with it.
    await http.post(`/users/${a.userId}/lock`).set("Authorization", `Bearer ${b.accessToken}`).expect(204);
    await http.post(`/users/${b.userId}/lock`).set("Authorization", `Bearer ${a.accessToken}`).expect(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).lockedAt).toBeNull();
  });

  it("records the old and new role when an admin changes a user's role", async () => {
    const clinicTenantId = (await createTenant(prisma, `PA-Role-${crypto.randomUUID()}`)).id;
    const admin = await createLoggedInUser(app, { tenantId: clinicTenantId, role: UserRole.CLINIC_ADMIN });
    const target = await createLoggedInUser(app, { tenantId: clinicTenantId, role: UserRole.LOCAL_IT });

    await http.patch(`/users/${target.userId}`).set("Authorization", `Bearer ${admin.accessToken}`).send({ role: "NURSING" }).expect(200);

    const audit = await prisma.auditLog.findFirst({ where: { tenantId: clinicTenantId, action: "USER_UPDATED", resourceId: target.userId } });
    expect(audit?.details).toMatchObject({ changedFields: ["role"], role: { from: "LOCAL_IT", to: "NURSING" } });
  });
});
