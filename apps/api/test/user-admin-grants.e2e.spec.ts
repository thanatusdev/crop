import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, type TestUser } from "./helpers.js";

/**
 * Lock, unlock and admin password reset follow ROLE_GRANTS, the same as creating or editing a
 * user: an admin may act on an account only if they could have created one with its role.
 */
describe("User admin actions respect ROLE_GRANTS", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let clinicAdmin: TestUser;
  let supervisor: TestUser;
  let nurse: TestUser;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
    const tenantId = (await createTenant(prisma, `Grants-${crypto.randomUUID()}`)).id;
    clinicAdmin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "grants-admin" });
    supervisor = await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_SUPERVISOR, emailPrefix: "grants-supervisor" });
    nurse = await createLoggedInUser(app, { tenantId, role: UserRole.NURSING, emailPrefix: "grants-nurse" });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("stops a LOCAL_SUPERVISOR from locking, unlocking or resetting the CLINIC_ADMIN", async () => {
    const auth = { Authorization: `Bearer ${supervisor.accessToken}` };
    await http.post(`/users/${clinicAdmin.userId}/lock`).set(auth).expect(403);
    await http.post(`/users/${clinicAdmin.userId}/unlock`).set(auth).expect(403);
    await http.post(`/users/${clinicAdmin.userId}/reset-password`).set(auth).send({ newPassword: "Outra-Senha-Forte-2026!" }).expect(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: clinicAdmin.userId } })).lockedAt).toBeNull();
  });

  it("still lets a LOCAL_SUPERVISOR lock and unlock NURSING, and the CLINIC_ADMIN lock the supervisor", async () => {
    await http.post(`/users/${nurse.userId}/lock`).set("Authorization", `Bearer ${supervisor.accessToken}`).expect(204);
    await http.post(`/users/${nurse.userId}/unlock`).set("Authorization", `Bearer ${supervisor.accessToken}`).expect(204);
    await http.post(`/users/${supervisor.userId}/lock`).set("Authorization", `Bearer ${clinicAdmin.accessToken}`).expect(204);
  });
});
