import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma } from "./helpers.js";

/**
 * `GET /auth/me` -- the caller's own identity, added for the nursing screen's header
 * ("Enfª Camila Rocha · COREN-SP 148209"), which otherwise has no way to learn its own name/
 * registration: `GET /users/:id` is `PLATFORM_ADMIN`/`CLINIC_ADMIN`/`OPERATOR_ADMIN` only,
 * and NURSING is deliberately not in that list. What a schema read alone wouldn't prove:
 *
 *  1. It's reachable by every role, unauthenticated by none.
 *  2. It answers with exactly the caller's *own* record -- never anyone else's, and never
 *     accepts an id to look one up by (there is no such parameter to pass).
 *  3. It never leaks passwordHash/mfaSecret.
 */
describe("GET /auth/me", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("returns the caller's own identity, including professionalRegistration", async () => {
    const tenant = await createTenant(prisma, `AuthMe-${crypto.randomUUID()}`);
    const nurse = await createLoggedInUser(app, {
      tenantId: tenant.id,
      role: UserRole.NURSING,
      emailPrefix: "nurse",
      firstName: "Camila",
      lastName: "Rocha",
    });
    await prisma.user.update({ where: { id: nurse.userId }, data: { professionalRegistration: "COREN-SP 148209" } });

    const res = await http.get("/auth/me").set("Authorization", `Bearer ${nurse.accessToken}`).expect(200);
    expect(res.body).toEqual({
      id: nurse.userId,
      email: nurse.email,
      role: "NURSING",
      firstName: "Camila",
      lastName: "Rocha",
      professionalRegistration: "COREN-SP 148209",
      tenantId: tenant.id,
    });
  });

  it("is reachable by every role -- self-scoped by construction, no @Roles gate at all", async () => {
    const tenant = await createTenant(prisma, `AuthMeRoles-${crypto.randomUUID()}`);
    for (const role of [UserRole.NURSING, UserRole.CLINIC_ADMIN, UserRole.AUDITOR, UserRole.LOCAL_IT, UserRole.LOCAL_SUPERVISOR]) {
      const user = await createLoggedInUser(app, { tenantId: tenant.id, role, emailPrefix: role.toLowerCase() });
      const res = await http.get("/auth/me").set("Authorization", `Bearer ${user.accessToken}`).expect(200);
      expect(res.body.role).toBe(role);
    }

    // The operator-side roles can't be created in a clinic tenant any more (see
    // ROLE_TENANT_TYPES), but "every role" has to keep meaning every role -- dropping them
    // from this sweep would quietly narrow what this test claims to cover. They come in
    // through the real contracted-operator path instead.
    for (const role of [UserRole.OPERATOR, UserRole.OPERATIONAL_SUPERVISOR, UserRole.OPERATOR_ADMIN]) {
      const user = await createContractedOperator(app, prisma, { clinicTenantId: tenant.id, role, emailPrefix: role.toLowerCase() });
      const res = await http.get("/auth/me").set("Authorization", `Bearer ${user.accessToken}`).expect(200);
      expect(res.body.role).toBe(role);
    }
  });

  it("rejects an unauthenticated request", async () => {
    await http.get("/auth/me").expect(401);
  });

  it("never leaks passwordHash or mfaSecret", async () => {
    const tenant = await createTenant(prisma, `AuthMeNoSecrets-${crypto.randomUUID()}`);
    const user = await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.LOCAL_IT, emailPrefix: "operator" });

    const res = await http.get("/auth/me").set("Authorization", `Bearer ${user.accessToken}`).expect(200);
    expect(res.body).not.toHaveProperty("passwordHash");
    expect(res.body).not.toHaveProperty("mfaSecret");
  });

  it("nullable firstName/lastName/professionalRegistration for a legacy-shaped account", async () => {
    const tenant = await createTenant(prisma, `AuthMeNulls-${crypto.randomUUID()}`);
    const user = await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.LOCAL_IT, emailPrefix: "legacy" });

    const res = await http.get("/auth/me").set("Authorization", `Bearer ${user.accessToken}`).expect(200);
    expect(res.body.firstName).toBeNull();
    expect(res.body.lastName).toBeNull();
    expect(res.body.professionalRegistration).toBeNull();
  });
});
