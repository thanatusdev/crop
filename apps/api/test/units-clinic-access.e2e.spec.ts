import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, unitPayload } from "./helpers.js";

/**
 * `UnitsController` used to trust `?clinicTenantId=` / `body.clinicTenantId` outright --
 * any authenticated role could create or list units under a clinic they had nothing to do
 * with, as long as it existed and was type CLINIC. `ClinicAccessChecker` closes that: a
 * caller may act on a clinic if they're PLATFORM_ADMIN, it's their own home tenant, they
 * have a real `UserClinicMembership` row for it, or their own home tenant is the
 * OPERATOR_PROVIDER linked to it via `Tenant.operatorTenantId` -- and, since this feature,
 * if the clinic itself isn't deactivated (see `ClinicAccessChecker`'s own docstring on why
 * that last check was missing until now despite `CreateUnitHandler` already claiming it).
 */
describe("Units: clinic-access scoping", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let clinicA: string;
  let clinicB: string;
  let operatorTenant: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    clinicA = (await createTenant(prisma, `UnitsClinicA-${crypto.randomUUID()}`)).id;
    clinicB = (await createTenant(prisma, `UnitsClinicB-${crypto.randomUUID()}`)).id;
    operatorTenant = (await createTenant(prisma, `UnitsOperator-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    // An ACTIVE agreement is what links an operating company to a clinic now -- this used to be
    // `prisma.tenant.update({ data: { operatorTenantId } })`, a column that no longer exists.
    //
    // No scope rows: this suite is about *clinic*-level access (may this company reach clinicB's
    // unit list at all), which `ClinicAccessChecker` answers from the relationship alone.
    // Per-equipment scope is a separate question, deliberately kept separate -- an operator with a
    // narrow scope is still legitimately linked to the clinic, and `operator-agreements.e2e.spec.ts`
    // is where that distinction is covered.
    await prisma.operatorAgreement.create({
      data: {
        clinicTenantId: clinicB,
        operatorTenantId: operatorTenant,
        status: "ACTIVE",
        proposedByTenantId: clinicB,
        respondedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("lets a CLINIC_ADMIN create and list units in their own clinic", async () => {
    const admin = await createLoggedInUser(app, { tenantId: clinicA, role: UserRole.CLINIC_ADMIN, emailPrefix: "units-own" });

    // CLINIC_ADMIN is itself an eligible technical manager, and this admin's own home
    // tenant is clinicA -- so the admin can name themselves, with no extra fixture needed.
    const created = await http
      .post("/units")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send(unitPayload(admin.userId, { name: "Unidade Teste" }))
      .expect(201);
    expect(created.body.clinicTenantId).toBe(clinicA);
    expect(created.body.technicalManager?.id).toBe(admin.userId);

    const listed = await http.get("/units").set("Authorization", `Bearer ${admin.accessToken}`).expect(200);
    expect(listed.body.some((u: { id: string }) => u.id === created.body.id)).toBe(true);

    const auditRows = await prisma.auditLog.findMany({ where: { tenantId: clinicA, resourceId: created.body.id } });
    expect(auditRows.some((row) => row.action === "UNIT_CREATED")).toBe(true);
  });

  it("rejects a CLINIC_ADMIN creating or listing units in an unrelated clinic", async () => {
    const admin = await createLoggedInUser(app, { tenantId: clinicA, role: UserRole.CLINIC_ADMIN, emailPrefix: "units-cross" });

    // Rejected by ClinicAccessChecker before technical-manager validation is ever reached,
    // so `admin.userId` here is just a placeholder -- it belongs to the wrong clinic too,
    // but that's not what this request actually fails on.
    const createRes = await http
      .post("/units")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send(unitPayload(admin.userId, { name: "Should Fail", clinicTenantId: clinicB }))
      .expect(403);
    expect(createRes.body.code).toBe("FORBIDDEN");

    const listRes = await http
      .get(`/units?clinicTenantId=${clinicB}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .expect(403);
    expect(listRes.body.code).toBe("FORBIDDEN");
  });

  /**
   * This test used to assert the opposite -- that an OPERATOR_ADMIN linked to a clinic could
   * *create* that clinic's units. Provisioning is now clinic-only (see UnitsController's
   * `@Roles` and roles.ts's role-model inversion): a unit belongs to the clinic that owns it,
   * and an operating company reaches it to read and operate, never to register.
   *
   * Both halves are asserted deliberately. The write being refused proves the `@Roles`
   * change; the read still succeeding proves the refusal comes from the role gate and not
   * from the operator link having been broken -- those two failure modes are indistinguishable
   * from a 403 on the write alone, and conflating them would hide a real regression in
   * `ClinicAccessChecker`, which Phase 2's agreement model is about to build directly on.
   */
  it("refuses unit creation to an OPERATOR_ADMIN even for a clinic it is linked to, while still allowing it to read that clinic's units", async () => {
    const opAdmin = await createLoggedInUser(app, { tenantId: operatorTenant, role: UserRole.OPERATOR_ADMIN, emailPrefix: "units-operator" });
    const clinicBManager = await createLoggedInUser(app, {
      tenantId: clinicB,
      role: UserRole.CLINIC_ADMIN,
      emailPrefix: "units-clinicb-manager",
    });

    const refused = await http
      .post("/units")
      .set("Authorization", `Bearer ${opAdmin.accessToken}`)
      .send(unitPayload(clinicBManager.userId, { name: "Unidade via Operadora", clinicTenantId: clinicB }))
      .expect(403);
    expect(refused.body.code).toBe("FORBIDDEN");

    // The operator link itself is intact: reads of the linked clinic still resolve (GET /units
    // is open to any authenticated role, scoped by ClinicAccessChecker), ...
    await http.get(`/units?clinicTenantId=${clinicB}`).set("Authorization", `Bearer ${opAdmin.accessToken}`).expect(200);

    // ... and a clinic the operator tenant is NOT linked to is still refused on read, so the
    // scoping is genuinely per-link rather than "operators can read everything".
    const unlinkedRead = await http
      .get(`/units?clinicTenantId=${clinicA}`)
      .set("Authorization", `Bearer ${opAdmin.accessToken}`)
      .expect(403);
    expect(unlinkedRead.body.code).toBe("FORBIDDEN");
  });

  it("lets a PLATFORM_ADMIN act on any clinic", async () => {
    const platformTenant = (await createTenant(prisma, `UnitsPlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN });
    // Same reasoning as the OPERATOR_ADMIN case above: the manager must be clinicA's own
    // staff, not the platform admin.
    const clinicAManager = await createLoggedInUser(app, {
      tenantId: clinicA,
      role: UserRole.CLINIC_ADMIN,
      emailPrefix: "units-clinica-manager",
    });

    await http
      .post("/units")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send(unitPayload(clinicAManager.userId, { name: "Unidade Superadmin", clinicTenantId: clinicA }))
      .expect(201);
  });

  it("rejects creating or listing units under a deactivated clinic, even for a PLATFORM_ADMIN", async () => {
    const deactivatedClinic = (await createTenant(prisma, `UnitsDeactivated-${crypto.randomUUID()}`)).id;
    // Logged in BEFORE the clinic is deactivated -- LoginHandler itself already refuses a
    // fresh login against a deactivated tenant (a separate, existing check), which is not
    // what this test is about; an already-issued token stays valid, since nothing re-checks
    // tenant status per request, so this is how the *later* checks (ClinicAccessChecker's
    // own, on an established session) actually get exercised.
    const clinicManager = await createLoggedInUser(app, {
      tenantId: deactivatedClinic,
      role: UserRole.CLINIC_ADMIN,
      emailPrefix: "units-deactivated-owner",
    });
    const platformTenant = (await createTenant(prisma, `UnitsPlatform2-${crypto.randomUUID()}`, "PLATFORM")).id;
    const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN, emailPrefix: "units-platform2" });

    await prisma.tenant.update({ where: { id: deactivatedClinic }, data: { deactivatedAt: new Date() } });

    // Its own admin, acting on their own home tenant -- would pass every actor check below,
    // and is exactly the case that was silently allowed before this fix.
    const ownAdminAttempt = await http
      .post("/units")
      .set("Authorization", `Bearer ${clinicManager.accessToken}`)
      .send(unitPayload(clinicManager.userId, { name: "Should Fail" }))
      .expect(403);
    expect(ownAdminAttempt.body.code).toBe("FORBIDDEN");

    // PLATFORM_ADMIN, which bypasses every *actor* check, still refused -- this is not a
    // permission question, it's "is this clinic even eligible to have units managed".
    const platformAttempt = await http
      .post("/units")
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .send(unitPayload(clinicManager.userId, { name: "Should Fail", clinicTenantId: deactivatedClinic }))
      .expect(403);
    expect(platformAttempt.body.code).toBe("FORBIDDEN");

    const listAttempt = await http
      .get(`/units?clinicTenantId=${deactivatedClinic}`)
      .set("Authorization", `Bearer ${platformAdmin.accessToken}`)
      .expect(403);
    expect(listAttempt.body.code).toBe("FORBIDDEN");
  });
});
