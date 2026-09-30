import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import {
  createTestApp,
  createLoggedInUser, createContractedOperator, grantWholeClinicScope,
  createTenant,
  testPrisma,
  unitPayload,
  equipmentPayload,
  decodeAccessToken,
} from "./helpers.js";

/**
 * The unit registry: a unit's institutional identity (establishment type, technical
 * manager, declared modalities) and physical address, its deactivation, the
 * equipment/room counts denormalized onto its DTO, the `?scope=all` cross-clinic listing,
 * and the session-start cascade that made `deactivatedAt` an orthogonal column on `Unit`
 * rather than a status value the way it is on `Equipment` -- see
 * `SetUnitDeactivatedHandler`'s own docstring for why. `units-clinic-access.e2e.spec.ts`
 * covers the actor-scoping rules (`ClinicAccessChecker`) this file does not re-assert.
 */
describe("Units registry", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let clinicId: string;
  let adminToken: string;
  let adminUserId: string;
  let operatorToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    clinicId = (await createTenant(prisma, `UnitRegistry-${crypto.randomUUID()}`)).id;
    const admin = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.CLINIC_ADMIN });
    adminToken = admin.accessToken;
    adminUserId = admin.userId;
    operatorToken = (await createContractedOperator(app, prisma, { clinicTenantId: clinicId, role: UserRole.OPERATOR, emailPrefix: "unit-registry-op" }))
      .accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function registerUnit(overrides: Record<string, unknown> = {}) {
    const res = await http
      .post("/units")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(unitPayload(adminUserId, overrides))
      .expect(201);
    // Extend the operator's agreement to cover the unit we just created.
    //
    // `createContractedOperator` grants every unit that existed when it ran, which covers the
    // common case (equipment created afterwards lands in the clinic's oldest unit). This spec is
    // the exception that case does not reach: it creates fresh units and puts equipment in them
    // *explicitly*, so without this the session-related assertions below would fail with a
    // scope 403 instead of exercising what they are actually about (unit deactivation cascading
    // to session start). Re-granting keeps this spec's subject its own, rather than silently
    // becoming a test of agreement scope.
    const agreement = await prisma.operatorAgreement.findFirstOrThrow({ where: { clinicTenantId: clinicId } });
    await grantWholeClinicScope(prisma, agreement.id, clinicId);
    return res.body as Record<string, unknown>;
  }

  describe("registration", () => {
    it("persists and returns every institutional/address field, denormalizing the technical manager", async () => {
      const body = await registerUnit({
        name: "Registry-Unit-Full",
        establishmentType: "IMAGING_CENTER",
        declaredModalities: ["MRI", "CT", "XRAY"],
        zipCode: "01310100",
        street: "Avenida Paulista",
        number: "1000",
        complement: "Bloco A - Térreo",
        district: "Bela Vista",
        city: "São Paulo",
        state: "SP",
        cnesCode: "7489201",
        phone: "(11) 3456-7890",
        technicalEmail: "unidade01@clinica1.com.br",
      });

      expect(body).toMatchObject({
        name: "Registry-Unit-Full",
        establishmentType: "IMAGING_CENTER",
        declaredModalities: ["MRI", "CT", "XRAY"],
        // Normalized to NNNNN-NNN even though it was sent without the hyphen.
        zipCode: "01310-100",
        street: "Avenida Paulista",
        district: "Bela Vista",
        city: "São Paulo",
        state: "SP",
        cnesCode: "7489201",
        deactivated: false,
        equipmentCount: 0,
        roomCount: 0,
      });
      expect(body.technicalManagerId).toBe(adminUserId);
      expect((body.technicalManager as { id: string }).id).toBe(adminUserId);
    });

    it("registers with no CNES/phone/e-mail on file", async () => {
      const body = await registerUnit({ name: "Registry-No-Contact" });
      expect(body.cnesCode).toBeNull();
      expect(body.phone).toBeNull();
      expect(body.technicalEmail).toBeNull();
    });

    it.each(["establishmentType", "technicalManagerId", "declaredModalities", "zipCode", "street", "number", "district", "city", "state"])(
      "rejects a registration with no %s, even though the column itself is nullable",
      async (field) => {
        const payload = unitPayload(adminUserId, { name: `Registry-Missing-${field}` });
        delete payload[field];
        await http.post("/units").set("Authorization", `Bearer ${adminToken}`).send(payload).expect(400);
      }
    );

    it("rejects a duplicate unit name within the same clinic, case-insensitively", async () => {
      await registerUnit({ name: "Registry-Duplicate" });
      const res = await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(adminUserId, { name: "registry-DUPLICATE" }))
        .expect(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("allows the same unit name in a different clinic", async () => {
      const otherClinicId = (await createTenant(prisma, `UnitRegistryOther-${crypto.randomUUID()}`)).id;
      const otherAdmin = await createLoggedInUser(app, {
        tenantId: otherClinicId,
        role: UserRole.CLINIC_ADMIN,
        emailPrefix: "unit-registry-other",
      });

      await registerUnit({ name: "Registry-Shared-Name" });
      await http
        .post("/units")
        .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
        .send(unitPayload(otherAdmin.userId, { name: "Registry-Shared-Name" }))
        .expect(201);
    });

    it("records the establishment type and declared modalities on the creation audit entry", async () => {
      const body = await registerUnit({ name: "Registry-Audited", declaredModalities: ["ULTRASOUND"] });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: body.id as string, action: "UNIT_CREATED" } });
      expect((log.details as { declaredModalities?: string[] }).declaredModalities).toEqual(["ULTRASOUND"]);
    });

    it("rejects an OPERATOR registering a unit", async () => {
      await http
        .post("/units")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send(unitPayload(adminUserId, { name: "Should Not Be Created" }))
        .expect(403);
    });
  });

  describe("technical manager eligibility", () => {
    it("rejects a technical manager who belongs to a different clinic", async () => {
      const otherClinicId = (await createTenant(prisma, `UnitRegistryTm-${crypto.randomUUID()}`)).id;
      const outsider = await createLoggedInUser(app, { tenantId: otherClinicId, role: UserRole.CLINIC_ADMIN, emailPrefix: "unit-tm-outsider" });

      const res = await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(outsider.userId, { name: "Registry-Wrong-Clinic-Manager" }))
        .expect(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });

    it("rejects a technical manager whose role isn't eligible (e.g. NURSING or OPERATOR)", async () => {
      const nurse = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.NURSING, emailPrefix: "unit-tm-nurse" });
      const res = await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(nurse.userId, { name: "Registry-Ineligible-Role" }))
        .expect(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("accepts LOCAL_SUPERVISOR and LOCAL_IT as technical managers", async () => {
      const supervisor = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.LOCAL_SUPERVISOR, emailPrefix: "unit-tm-sup" });
      await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(supervisor.userId, { name: "Registry-Supervisor-Manager" }))
        .expect(201);

      const itStaff = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.LOCAL_IT, emailPrefix: "unit-tm-it" });
      await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(itStaff.userId, { name: "Registry-IT-Manager" }))
        .expect(201);
    });

    it("rejects a technical manager whose account has not been activated", async () => {
      const unactivated = await prisma.user.create({
        data: { tenantId: clinicId, email: `unit-tm-unactivated-${crypto.randomUUID()}@test.crop.health`, passwordHash: "unused", role: "CLINIC_ADMIN" },
      });
      const res = await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(unactivated.id, { name: "Registry-Unactivated-Manager" }))
        .expect(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a technical manager whose account is locked", async () => {
      const locked = await prisma.user.create({
        data: {
          tenantId: clinicId,
          email: `unit-tm-locked-${crypto.randomUUID()}@test.crop.health`,
          passwordHash: "unused",
          role: "CLINIC_ADMIN",
          activatedAt: new Date(),
          lockedAt: new Date(),
        },
      });
      const res = await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(unitPayload(locked.id, { name: "Registry-Locked-Manager" }))
        .expect(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("GET /units/technical-managers lists only eligible, activated, unlocked staff of the given clinic", async () => {
      const res = await http.get(`/units/technical-managers?clinicTenantId=${clinicId}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
      const ids = (res.body as { id: string }[]).map((o) => o.id);
      expect(ids).toContain(adminUserId);
      // The operator created in beforeAll is ineligible (wrong role) and must not appear.
      expect(ids).not.toContain(decodeAccessToken(operatorToken).sub);
    });

    it("rejects listing technical-manager options for a clinic the caller can't access", async () => {
      const otherClinicId = (await createTenant(prisma, `UnitRegistryTmList-${crypto.randomUUID()}`)).id;
      await http.get(`/units/technical-managers?clinicTenantId=${otherClinicId}`).set("Authorization", `Bearer ${adminToken}`).expect(403);
    });
  });

  describe("editing", () => {
    it("updates one field without resending the rest", async () => {
      const created = await registerUnit({ name: "Registry-Editable", city: "São Paulo" });
      const res = await http
        .patch(`/units/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ city: "Campinas" })
        .expect(200);
      expect(res.body.city).toBe("Campinas");
      expect(res.body.street).toBe("Avenida Paulista"); // untouched field survives
    });

    it("refuses to blank out a required-on-create field", async () => {
      const created = await registerUnit({ name: "Registry-No-Blanking" });
      await http.patch(`/units/${created.id as string}`).set("Authorization", `Bearer ${adminToken}`).send({ street: null }).expect(400);
    });

    it("allows unassigning the technical manager, unlike every other required-on-create field", async () => {
      const created = await registerUnit({ name: "Registry-Unassign-Manager" });
      const res = await http
        .patch(`/units/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ technicalManagerId: null })
        .expect(200);
      expect(res.body.technicalManagerId).toBeNull();
      expect(res.body.technicalManager).toBeNull();
    });

    it("re-validates a new technical manager's eligibility on update too", async () => {
      const created = await registerUnit({ name: "Registry-Reassign-Manager" });
      const nurse = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.NURSING, emailPrefix: "unit-edit-nurse" });
      await http
        .patch(`/units/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ technicalManagerId: nurse.userId })
        .expect(400);
    });

    it("rejects renaming a unit to a name already used by another unit in the same clinic", async () => {
      await registerUnit({ name: "Registry-Taken-Name" });
      const created = await registerUnit({ name: "Registry-Renameable" });
      const res = await http
        .patch(`/units/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Registry-Taken-Name" })
        .expect(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("silently ignores an attempt to change clinicTenantId -- there is no such field on the contract", async () => {
      const created = await registerUnit({ name: "Registry-No-Clinic-Move" });
      const otherClinicId = (await createTenant(prisma, `UnitRegistryMove-${crypto.randomUUID()}`)).id;
      const res = await http
        .patch(`/units/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ clinicTenantId: otherClinicId, city: "Osasco" })
        .expect(200);
      expect(res.body.clinicTenantId).toBe(clinicId);
      expect(res.body.city).toBe("Osasco");
    });

    it("rejects an OPERATOR editing a unit", async () => {
      const created = await registerUnit({ name: "Registry-Operator-Edit-Blocked" });
      await http.patch(`/units/${created.id as string}`).set("Authorization", `Bearer ${operatorToken}`).send({ city: "Blocked" }).expect(403);
    });

    it("audits every edit under UNIT_UPDATED, attributing the acting admin", async () => {
      const created = await registerUnit({ name: "Registry-Edit-Audited" });
      await http.patch(`/units/${created.id as string}`).set("Authorization", `Bearer ${adminToken}`).send({ city: "Audited-City" }).expect(200);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: created.id as string, action: "UNIT_UPDATED" } });
      expect(log.userId).toBe(adminUserId);
      expect((log.details as { changedFields?: string[] }).changedFields).toEqual(["city"]);
    });
  });

  describe("deactivation", () => {
    it("retires a unit and returns it, idempotently, without ever deleting the row", async () => {
      const created = await registerUnit({ name: "Registry-Retire" });
      const id = created.id as string;

      const deactivated = await http.post(`/units/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      expect(deactivated.body.deactivated).toBe(true);
      expect(await prisma.unit.findUnique({ where: { id } })).not.toBeNull();

      const again = await http.post(`/units/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      expect(again.body.deactivated).toBe(true);

      const reactivated = await http.post(`/units/${id}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      expect(reactivated.body.deactivated).toBe(false);
    });

    it("audits deactivation and reactivation as their own actions", async () => {
      const created = await registerUnit({ name: "Registry-Audit-Retire" });
      const id = created.id as string;

      await http.post(`/units/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      await http.post(`/units/${id}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);

      await prisma.auditLog.findFirstOrThrow({ where: { resourceId: id, action: "UNIT_DEACTIVATED" } });
      await prisma.auditLog.findFirstOrThrow({ where: { resourceId: id, action: "UNIT_REACTIVATED" } });
    });

    it("rejects an OPERATOR deactivating a unit", async () => {
      const created = await registerUnit({ name: "Registry-Operator-Deactivate-Blocked" });
      await http.post(`/units/${created.id as string}/deactivate`).set("Authorization", `Bearer ${operatorToken}`).expect(403);
    });

    /**
     * The regression test that justifies the session-start cascade existing at all.
     * `SetUnitDeactivatedHandler` never touches its equipment's own `deactivatedAt` or
     * `status` -- retiring the *unit* leaves a healthy, ONLINE device looking exactly as
     * available as it did a moment ago. Only `StartSessionHandler`'s own extra check
     * (loading the equipment's unit) stands between that frozen appearance and an actual
     * session starting on a piece of equipment whose unit is out of service.
     */
    it("refuses to start a session on equipment whose unit has been deactivated, and allows it again once reactivated", async () => {
      const unit = await registerUnit({ name: "Registry-Cascade-Unit" });
      const equipment = await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Cascade-Equipment", unitId: unit.id }))
        .expect(201);
      await prisma.equipment.update({ where: { id: equipment.body.id }, data: { status: "ONLINE" } });

      await http.post(`/units/${unit.id as string}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);

      const frozen = await prisma.equipment.findUniqueOrThrow({ where: { id: equipment.body.id } });
      expect(frozen.status).toBe("ONLINE"); // untouched by unit deactivation

      const blocked = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: equipment.body.id }).expect(409);
      expect(blocked.body.code).toBe("CONFLICT");
      expect(blocked.body.message).toContain("unit");

      await http.post(`/units/${unit.id as string}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: equipment.body.id }).expect(201);
    });

    it("does not resurrect equipment an admin retired independently, when its unit is reactivated", async () => {
      const unit = await registerUnit({ name: "Registry-Independent-Retire-Unit" });
      const equipment = await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Independent-Retire-Equipment", unitId: unit.id }))
        .expect(201);

      await http.post(`/equipment/${equipment.body.id as string}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      await http.post(`/units/${unit.id as string}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      await http.post(`/units/${unit.id as string}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);

      const stillRetired = await prisma.equipment.findUniqueOrThrow({ where: { id: equipment.body.id as string } });
      expect(stillRetired.deactivatedAt).not.toBeNull();
    });
  });

  describe("equipment/room counts", () => {
    it("counts all equipment (retired or not) but only rooms from non-retired equipment", async () => {
      const unit = await registerUnit({ name: "Registry-Counts-Unit" });

      const roomA = await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-A", unitId: unit.id, roomLabel: "Sala A" }))
        .expect(201);
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-B", unitId: unit.id, roomLabel: "Sala B" }))
        .expect(201);
      const retired = await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-C", unitId: unit.id, roomLabel: "Sala C" }))
        .expect(201);
      await http.post(`/equipment/${retired.body.id as string}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);

      const res = await http.get(`/units/${unit.id as string}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
      expect(res.body.equipmentCount).toBe(3); // includes the retired device
      expect(res.body.roomCount).toBe(2); // excludes Sala C, whose only equipment is retired

      // Two devices sharing one room count as one room, not two.
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-A2", unitId: unit.id, roomLabel: "Sala A" }))
        .expect(201);
      const res2 = await http.get(`/units/${unit.id as string}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
      expect(res2.body.equipmentCount).toBe(4);
      expect(res2.body.roomCount).toBe(2);

      void roomA; // referenced only for readability of the setup above
    });
  });

  describe("GET /units/:id", () => {
    it("404s for a unit that doesn't exist", async () => {
      await http.get("/units/00000000-0000-0000-0000-000000000000").set("Authorization", `Bearer ${adminToken}`).expect(404);
    });

    it("403s for a unit that exists but belongs to a clinic the caller can't access", async () => {
      const otherClinicId = (await createTenant(prisma, `UnitRegistryGet-${crypto.randomUUID()}`)).id;
      const otherAdmin = await createLoggedInUser(app, {
        tenantId: otherClinicId,
        role: UserRole.CLINIC_ADMIN,
        emailPrefix: "unit-registry-get-other",
      });
      const otherUnit = await http
        .post("/units")
        .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
        .send(unitPayload(otherAdmin.userId, { name: "Registry-Other-Clinic-Unit" }))
        .expect(201);

      await http.get(`/units/${otherUnit.body.id as string}`).set("Authorization", `Bearer ${adminToken}`).expect(403);
    });
  });

  describe("?scope=all", () => {
    it("returns units across every clinic a PLATFORM_ADMIN can reach", async () => {
      const otherClinicId = (await createTenant(prisma, `UnitRegistryScope-${crypto.randomUUID()}`)).id;
      const otherAdmin = await createLoggedInUser(app, {
        tenantId: otherClinicId,
        role: UserRole.CLINIC_ADMIN,
        emailPrefix: "unit-registry-scope-other",
      });
      const otherUnit = await http
        .post("/units")
        .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
        .send(unitPayload(otherAdmin.userId, { name: "Registry-Scope-Other-Unit" }))
        .expect(201);
      const ownUnit = await registerUnit({ name: "Registry-Scope-Own-Unit" });

      const platformTenant = (await createTenant(prisma, `UnitRegistryPlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
      const platformAdmin = await createLoggedInUser(app, { tenantId: platformTenant, role: UserRole.PLATFORM_ADMIN, emailPrefix: "unit-registry-platform" });

      const res = await http.get("/units?scope=all").set("Authorization", `Bearer ${platformAdmin.accessToken}`).expect(200);
      const ids = (res.body as { id: string }[]).map((u) => u.id);
      expect(ids).toContain(otherUnit.body.id);
      expect(ids).toContain(ownUnit.id);
    });

    it("scopes a non-platform caller to their own clinic's units only, with no membership/operator link to any other", async () => {
      const otherClinicId = (await createTenant(prisma, `UnitRegistryScope2-${crypto.randomUUID()}`)).id;
      const otherAdmin = await createLoggedInUser(app, {
        tenantId: otherClinicId,
        role: UserRole.CLINIC_ADMIN,
        emailPrefix: "unit-registry-scope2-other",
      });
      const otherUnit = await http
        .post("/units")
        .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
        .send(unitPayload(otherAdmin.userId, { name: "Registry-Scope2-Other-Unit" }))
        .expect(201);
      const ownUnit = await registerUnit({ name: "Registry-Scope2-Own-Unit" });

      const res = await http.get("/units?scope=all").set("Authorization", `Bearer ${adminToken}`).expect(200);
      const ids = (res.body as { id: string }[]).map((u) => u.id);
      expect(ids).toContain(ownUnit.id);
      expect(ids).not.toContain(otherUnit.body.id);
    });
  });
});
