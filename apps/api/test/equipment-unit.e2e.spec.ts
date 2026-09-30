import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, equipmentPayload, unitPayload, decodeAccessToken } from "./helpers.js";

/**
 * `Equipment.unitId` existed as a backfilled Prisma column with zero application-layer
 * wiring until now -- not in the contract schemas, not in the create/update commands, not
 * in the repository port. This covers the three real behaviors `CreateEquipmentHandler`/
 * `UpdateEquipmentHandler` now implement: an explicit unit is validated against the
 * equipment's own tenant, an omitted one auto-resolves (creating a default unit if the
 * clinic has none), and a cross-tenant unit is rejected outright.
 */
describe("Equipment <-> Unit wiring", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;
  let otherTenantId: string;
  let adminToken: string;
  // The CLINIC_ADMIN's own id -- eligible to be a unit's technical manager in their own
  // clinic (see unitPayload's own docstring for why this can't be a fixed dummy value).
  let adminUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    tenantId = (await createTenant(prisma, `EqUnit-${crypto.randomUUID()}`)).id;
    otherTenantId = (await createTenant(prisma, `EqUnitOther-${crypto.randomUUID()}`)).id;
    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
    adminUserId = decodeAccessToken(adminToken).sub;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("auto-resolves to a freshly created default unit when the clinic has none and none is specified", async () => {
    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Auto-Default-MRI" }))
      .expect(201);

    expect(res.body.unitId).toBeTruthy();
    const unit = await prisma.unit.findUniqueOrThrow({ where: { id: res.body.unitId } });
    expect(unit.clinicTenantId).toBe(tenantId);
    expect(unit.name).toBe("Unidade Principal");
  });

  it("auto-resolves to the clinic's oldest existing unit when one already exists and none is specified", async () => {
    const unitRes = await http
      .post("/units")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(unitPayload(adminUserId, { name: "Unidade Explícita" }))
      .expect(201);

    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Second-Equipment" }))
      .expect(201);

    // Oldest existing unit for this tenant -- the "Unidade Principal" the previous test's
    // auto-default created, not the one just created above.
    expect(res.body.unitId).not.toBe(unitRes.body.id);
  });

  it("accepts an explicit unitId belonging to the same tenant", async () => {
    const unitRes = await http
      .post("/units")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(unitPayload(adminUserId, { name: "Unidade Escolhida" }))
      .expect(201);

    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Explicit-Unit-Equipment", unitId: unitRes.body.id }))
      .expect(201);

    expect(res.body.unitId).toBe(unitRes.body.id);
  });

  it("rejects an explicit unitId belonging to a different tenant, both on create and update", async () => {
    const otherAdmin = await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "eq-unit-other" });
    const otherUnit = await http
      .post("/units")
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
      .send(unitPayload(otherAdmin.userId, { name: "Unidade Estranha" }))
      .expect(201);

    const createRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Should-Fail", unitId: otherUnit.body.id }))
      .expect(403);
    expect(createRes.body.code).toBe("FORBIDDEN");

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Reassign-Target" }))
      .expect(201);

    const updateRes = await http
      .patch(`/equipment/${equipmentRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ unitId: otherUnit.body.id })
      .expect(403);
    expect(updateRes.body.code).toBe("FORBIDDEN");
  });

  it("lets an admin reassign equipment to a different unit within the same tenant", async () => {
    const newUnit = await http
      .post("/units")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(unitPayload(adminUserId, { name: "Unidade Nova" }))
      .expect(201);
    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Reassignable" }))
      .expect(201);

    const updateRes = await http
      .patch(`/equipment/${equipmentRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ unitId: newUnit.body.id })
      .expect(200);
    expect(updateRes.body.unitId).toBe(newUnit.body.id);
  });
});
