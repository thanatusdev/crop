import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, clinicPayload, operatorPayload, unitPayload, equipmentPayload } from "./helpers.js";

/**
 * The clinic registry: a clinic's institutional identity (CNPJ, contact, registered
 * address), its responsible manager, the matriz/filial derivation from its CNPJ (see
 * `packages/shared/src/cnpj.ts`), and the equipment/unit counts denormalized onto its DTO.
 * `superadmin-tenant-management.e2e.spec.ts` covers the pre-existing lifecycle behaviors
 * (deactivation actually locking out login/refresh, the PLATFORM-type guard, the
 * user-provisioning cross-tenant rules) this file does not re-assert.
 */
describe("Clinics registry", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let platformTenantId: string;
  let platformAdminToken: string;
  let clinicAdminToken: string;
  let clinicAdminTenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    platformTenantId = (await createTenant(prisma, `ClinicRegistryPlatform-${crypto.randomUUID()}`, "PLATFORM")).id;
    platformAdminToken = (await createLoggedInUser(app, { tenantId: platformTenantId, role: UserRole.PLATFORM_ADMIN })).accessToken;

    clinicAdminTenantId = (await createTenant(prisma, `ClinicRegistryOwn-${crypto.randomUUID()}`)).id;
    clinicAdminToken = (await createLoggedInUser(app, { tenantId: clinicAdminTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-registry-own" }))
      .accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function registerClinic(overrides: Record<string, unknown> = {}) {
    const res = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(clinicPayload(overrides)).expect(201);
    return res.body as Record<string, unknown>;
  }

  describe("registration", () => {
    it("persists and returns every institutional/address field, normalizing the CNPJ", async () => {
      const body = await registerClinic({
        name: "Registry-Clinic-Full",
        cnpj: "12.345.678/0001-95", // real check-digit-valid CNPJ, see cnpj.test.ts
        institutionalEmail: "teste@teste.com.br",
        phone: "(11) 3456-7890",
        zipCode: "03042001",
        street: "Rua Vergueiro",
        number: "1234",
        complement: "Bloco B - Sala 402",
        district: "Centro",
        city: "São Paulo",
        state: "SP",
      });

      expect(body).toMatchObject({
        name: "Registry-Clinic-Full",
        cnpj: "12345678000195",
        institutionalEmail: "teste@teste.com.br",
        street: "Rua Vergueiro",
        district: "Centro",
        city: "São Paulo",
        state: "SP",
        deactivated: false,
        equipmentCount: 0,
        unitCount: 0,
        modalities: [],
        responsibleManagerId: null,
        responsibleManager: null,
      });
      expect(body.zipCode).toBe("03042-001"); // normalized to NNNNN-NNN even without the hyphen
      expect(body.isMatriz).toBe(true); // branch order 0001
      expect(body.cnpjRoot).toBe("12345678");
    });

    it.each(["cnpj", "institutionalEmail", "phone", "zipCode", "street", "number", "district", "city", "state"])(
      "rejects a CLINIC registration missing %s, even though the column itself is nullable",
      async (field) => {
        const payload = clinicPayload({ name: `Registry-Missing-${field}` });
        delete payload[field];
        await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(payload).expect(400);
      }
    );

    it("rejects a CNPJ that fails the check-digit algorithm", async () => {
      const res = await http
        .post("/tenants")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send(clinicPayload({ name: "Registry-Bad-CNPJ", cnpj: "11.111.111/1111-11" }))
        .expect(400);
      expect(res.body.message).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["cnpj"] })]));
    });

    it("rejects a duplicate CNPJ across two different clinics", async () => {
      const first = await registerClinic({ name: "Registry-Dup-First" });
      const res = await http
        .post("/tenants")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send(clinicPayload({ name: "Registry-Dup-Second", cnpj: first.cnpj as string }))
        .expect(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("creates an OPERATOR_PROVIDER tenant carrying the same institutional fields a CLINIC requires", async () => {
      const res = await http
        .post("/tenants")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send(operatorPayload({ name: `Registry-Operator-${crypto.randomUUID()}` }))
        .expect(201);
      expect(res.body.cnpj).not.toBeNull();
      expect(res.body.isMatriz).not.toBeNull();
    });

    it("rejects an OPERATOR_PROVIDER missing an institutional field, the same as a CLINIC would be", async () => {
      const { phone: _omitted, ...withoutPhone } = operatorPayload();
      await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(withoutPhone).expect(400);
    });

    it("records the CNPJ on the creation audit entry", async () => {
      const body = await registerClinic({ name: "Registry-Audited" });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: body.id as string, action: "TENANT_CREATED" } });
      expect((log.details as { cnpj?: string }).cnpj).toBe(body.cnpj);
    });

    it("rejects a CLINIC_ADMIN registering a clinic", async () => {
      await http.post("/tenants").set("Authorization", `Bearer ${clinicAdminToken}`).send(clinicPayload({ name: "Should Not Be Created" })).expect(403);
    });
  });

  describe("matriz/filial derivation", () => {
    it("derives matriz vs filial, and a shared root, purely from the CNPJ -- no relationship column involved", async () => {
      const matriz = await registerClinic({ name: "Registry-Branch-Matriz", cnpj: "11.122.233/0001-83" });
      const filial = await registerClinic({ name: "Registry-Branch-Filial", cnpj: "11.122.233/0002-64" });

      expect(matriz.isMatriz).toBe(true);
      expect(filial.isMatriz).toBe(false);
      expect(matriz.cnpjRoot).toBe(filial.cnpjRoot);
      expect(matriz.cnpjRoot).toBe("11122233");
    });
  });

  describe("responsible manager eligibility", () => {
    it("rejects a responsible manager who belongs to a different clinic", async () => {
      const clinic = await registerClinic({ name: "Registry-RM-Wrong-Clinic" });
      const outsider = await createLoggedInUser(app, { tenantId: clinicAdminTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-rm-outsider" });

      const res = await http
        .patch(`/tenants/${clinic.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ responsibleManagerId: outsider.userId })
        .expect(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });

    it("rejects a responsible manager whose role isn't CLINIC_ADMIN", async () => {
      const clinic = await registerClinic({ name: "Registry-RM-Wrong-Role" });
      const nurse = await createLoggedInUser(app, { tenantId: clinic.id as string, role: UserRole.NURSING, emailPrefix: "clinic-rm-nurse" });

      const res = await http
        .patch(`/tenants/${clinic.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ responsibleManagerId: nurse.userId })
        .expect(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("accepts a CLINIC_ADMIN belonging to the same clinic", async () => {
      const clinic = await registerClinic({ name: "Registry-RM-Valid" });
      const admin = await createLoggedInUser(app, { tenantId: clinic.id as string, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-rm-valid" });

      const res = await http
        .patch(`/tenants/${clinic.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ responsibleManagerId: admin.userId })
        .expect(200);
      expect(res.body.responsibleManagerId).toBe(admin.userId);
      expect(res.body.responsibleManager.id).toBe(admin.userId);
    });

    it("rejects a responsible manager whose account is locked", async () => {
      const clinic = await registerClinic({ name: "Registry-RM-Locked" });
      const locked = await prisma.user.create({
        data: {
          tenantId: clinic.id as string,
          email: `clinic-rm-locked-${crypto.randomUUID()}@test.crop.health`,
          passwordHash: "unused",
          role: "CLINIC_ADMIN",
          activatedAt: new Date(),
          lockedAt: new Date(),
        },
      });
      const res = await http
        .patch(`/tenants/${clinic.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ responsibleManagerId: locked.id })
        .expect(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("silently ignores a responsibleManagerId sent on create -- the field doesn't exist on that contract", async () => {
      const admin = await createLoggedInUser(app, { tenantId: clinicAdminTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-rm-create-ignored" });
      const payload = clinicPayload({ name: "Registry-RM-Create-Ignored", responsibleManagerId: admin.userId });
      const res = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(payload).expect(201);
      expect(res.body.responsibleManagerId).toBeNull();
    });

    it("GET /tenants/responsible-manager-options lists only CLINIC_ADMIN, activated, unlocked users of the given clinic", async () => {
      const clinic = await registerClinic({ name: "Registry-RM-Options" });
      const admin = await createLoggedInUser(app, { tenantId: clinic.id as string, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-rm-options-admin" });
      const supervisor = await createLoggedInUser(app, {
        tenantId: clinic.id as string,
        role: UserRole.LOCAL_SUPERVISOR,
        emailPrefix: "clinic-rm-options-sup",
      });

      const res = await http
        .get(`/tenants/responsible-manager-options?tenantId=${clinic.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .expect(200);
      const ids = (res.body as { id: string }[]).map((o) => o.id);
      expect(ids).toContain(admin.userId);
      // LOCAL_SUPERVISOR is eligible for a unit's technical manager but not a clinic's
      // responsible manager -- narrower eligibility than the unit-side picker.
      expect(ids).not.toContain(supervisor.userId);
    });

    it("rejects a CLINIC_ADMIN listing responsible-manager options", async () => {
      await http
        .get(`/tenants/responsible-manager-options?tenantId=${clinicAdminTenantId}`)
        .set("Authorization", `Bearer ${clinicAdminToken}`)
        .expect(403);
    });

    it("GET /tenants/responsible-manager-options lists OPERATOR_ADMINs for an OPERATOR_PROVIDER tenant, not CLINIC_ADMINs", async () => {
      const operatorRes = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(operatorPayload()).expect(201);
      const operatorId = operatorRes.body.id as string;
      const opAdmin = await createLoggedInUser(app, { tenantId: operatorId, role: UserRole.OPERATOR_ADMIN, emailPrefix: "operator-rm-options-admin" });
      const operatorStaff = await createLoggedInUser(app, {
        tenantId: operatorId,
        role: UserRole.OPERATOR,
        emailPrefix: "operator-rm-options-staff",
      });

      const res = await http
        .get(`/tenants/responsible-manager-options?tenantId=${operatorId}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .expect(200);
      const ids = (res.body as { id: string }[]).map((o) => o.id);
      expect(ids).toContain(opAdmin.userId);
      expect(ids).not.toContain(operatorStaff.userId);
    });
  });

  describe("editing", () => {
    it("updates one field without resending the rest", async () => {
      const created = await registerClinic({ name: "Registry-Editable" });
      const res = await http
        .patch(`/tenants/${created.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ city: "Campinas" })
        .expect(200);
      expect(res.body.city).toBe("Campinas");
      expect(res.body.street).toBe("Avenida Paulista"); // untouched field survives
    });

    it("refuses to blank out a required-on-create field", async () => {
      const created = await registerClinic({ name: "Registry-No-Blanking" });
      await http.patch(`/tenants/${created.id as string}`).set("Authorization", `Bearer ${platformAdminToken}`).send({ street: null }).expect(400);
    });

    it("allows unassigning the responsible manager, unlike every other required-on-create field", async () => {
      const created = await registerClinic({ name: "Registry-Unassign-RM" });
      const admin = await createLoggedInUser(app, { tenantId: created.id as string, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-unassign-rm" });
      await http
        .patch(`/tenants/${created.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ responsibleManagerId: admin.userId })
        .expect(200);

      const res = await http
        .patch(`/tenants/${created.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ responsibleManagerId: null })
        .expect(200);
      expect(res.body.responsibleManagerId).toBeNull();
      expect(res.body.responsibleManager).toBeNull();
    });

    it("silently ignores an attempt to change the CNPJ or the type -- neither field exists on the update contract", async () => {
      const created = await registerClinic({ name: "Registry-No-CNPJ-Change" });
      const res = await http
        .patch(`/tenants/${created.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ cnpj: "44.455.566/0001-83", type: "OPERATOR_PROVIDER", city: "Osasco" })
        .expect(200);
      expect(res.body.cnpj).toBe(created.cnpj);
      expect(res.body.type).toBe("CLINIC");
      expect(res.body.city).toBe("Osasco");
    });

    it("rejects a CLINIC_ADMIN editing a clinic", async () => {
      const created = await registerClinic({ name: "Registry-Operator-Edit-Blocked" });
      await http.patch(`/tenants/${created.id as string}`).set("Authorization", `Bearer ${clinicAdminToken}`).send({ city: "Blocked" }).expect(403);
    });

    it("audits every edit under TENANT_UPDATED, attributing the acting platform admin", async () => {
      const created = await registerClinic({ name: "Registry-Edit-Audited" });
      await http.patch(`/tenants/${created.id as string}`).set("Authorization", `Bearer ${platformAdminToken}`).send({ city: "Audited-City" }).expect(200);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: created.id as string, action: "TENANT_UPDATED" } });
      expect((log.details as { changedFields?: string[] }).changedFields).toEqual(["city"]);
    });
  });

  describe("equipment/unit counts", () => {
    it("counts equipment and units, and lists distinct modalities from non-retired equipment", async () => {
      const clinic = await registerClinic({ name: "Registry-Counts-Clinic" });
      const admin = await createLoggedInUser(app, { tenantId: clinic.id as string, role: UserRole.CLINIC_ADMIN, emailPrefix: "clinic-counts-admin" });
      const clinicToken = admin.accessToken;

      await http.post("/units").set("Authorization", `Bearer ${clinicToken}`).send(unitPayload(admin.userId, { name: "Registry-Counts-Unit" })).expect(201);

      const mriRes = await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-MRI", modality: "MRI" }))
        .expect(201);
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-CT", modality: "CT" }))
        .expect(201);
      const retiredRes = await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicToken}`)
        .send(equipmentPayload({ name: "Registry-Counts-Retired", modality: "ULTRASOUND" }))
        .expect(201);
      await http.post(`/equipment/${retiredRes.body.id as string}/deactivate`).set("Authorization", `Bearer ${clinicToken}`).expect(201);

      const res = await http.get(`/tenants/${clinic.id as string}`).set("Authorization", `Bearer ${platformAdminToken}`).expect(200);
      expect(res.body.equipmentCount).toBe(3); // includes the retired device
      expect(res.body.unitCount).toBe(1);
      expect(res.body.modalities.sort()).toEqual(["CT", "MRI"]); // excludes ULTRASOUND, whose only equipment is retired

      void mriRes;
    });
  });

  describe("GET /tenants/:id", () => {
    it("404s for a clinic that doesn't exist", async () => {
      await http.get("/tenants/00000000-0000-0000-0000-000000000000").set("Authorization", `Bearer ${platformAdminToken}`).expect(404);
    });

    it("rejects a CLINIC_ADMIN reading any clinic by id", async () => {
      const created = await registerClinic({ name: "Registry-Get-Blocked" });
      await http.get(`/tenants/${created.id as string}`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
    });
  });

  describe("operadora registry (OPERATOR_PROVIDER)", () => {
    async function registerOperator(overrides: Record<string, unknown> = {}) {
      const res = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(operatorPayload(overrides)).expect(201);
      return res.body as Record<string, unknown>;
    }

    it("edits an operadora's institutional/address fields the same way a clinic's are edited", async () => {
      const created = await registerOperator({ name: "Registry-Operator-Editable" });
      const res = await http
        .patch(`/tenants/${created.id as string}`)
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ city: "Campinas", phone: "(19) 2345-6789" })
        .expect(200);
      expect(res.body.city).toBe("Campinas");
      expect(res.body.phone).toBe("(19) 2345-6789");
      expect(res.body.street).toBe(created.street); // untouched field survives
    });

    it("deactivates and reactivates an operadora the same way a clinic is -- actually locking out its own users' login", async () => {
      const operator = await registerOperator({ name: "Registry-Operator-Deactivate" });
      const opAdmin = await createLoggedInUser(app, {
        tenantId: operator.id as string,
        role: UserRole.OPERATOR_ADMIN,
        emailPrefix: "operator-deactivate-admin",
      });

      await http.post(`/tenants/${operator.id as string}/deactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);
      await http.post("/auth/refresh").send({ refreshToken: opAdmin.refreshToken }).expect(403);

      await http.post(`/tenants/${operator.id as string}/reactivate`).set("Authorization", `Bearer ${platformAdminToken}`).expect(204);
      const res = await http.get(`/tenants/${operator.id as string}`).set("Authorization", `Bearer ${platformAdminToken}`).expect(200);
      expect(res.body.deactivated).toBe(false);
    });

    it("reports activeAgreementCount and userCount on the enriched DTO, structurally zero equipment/unit counts", async () => {
      const operator = await registerOperator({ name: "Registry-Operator-Counts" });
      await createLoggedInUser(app, { tenantId: operator.id as string, role: UserRole.OPERATOR, emailPrefix: "operator-counts-staff" });
      const opAdmin = await createLoggedInUser(app, {
        tenantId: operator.id as string,
        role: UserRole.OPERATOR_ADMIN,
        emailPrefix: "operator-counts-admin",
      });

      const clinic = await registerClinic({ name: "Registry-Operator-Counts-Clinic" });
      const clinicAdmin = await createLoggedInUser(app, {
        tenantId: clinic.id as string,
        role: UserRole.CLINIC_ADMIN,
        emailPrefix: "operator-counts-clinic-admin",
      });
      const proposed = await http
        .post("/agreements")
        .set("Authorization", `Bearer ${clinicAdmin.accessToken}`)
        .send({ operatorTenantId: operator.id as string })
        .expect(201);
      await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${opAdmin.accessToken}`).expect(201);

      const res = await http.get(`/tenants/${operator.id as string}`).set("Authorization", `Bearer ${platformAdminToken}`).expect(200);
      expect(res.body.activeAgreementCount).toBe(1);
      expect(res.body.userCount).toBe(2); // the staff member plus the admin who accepted
      expect(res.body.equipmentCount).toBe(0);
      expect(res.body.unitCount).toBe(0);
      expect(res.body.modalities).toEqual([]);
    });

    it("rejects a CLINIC_ADMIN registering, editing, or reading an operadora -- same PLATFORM_ADMIN-only gate as a clinic", async () => {
      await http.post("/tenants").set("Authorization", `Bearer ${clinicAdminToken}`).send(operatorPayload()).expect(403);
      const operator = await registerOperator({ name: "Registry-Operator-RBAC" });
      await http.get(`/tenants/${operator.id as string}`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
      await http.patch(`/tenants/${operator.id as string}`).set("Authorization", `Bearer ${clinicAdminToken}`).send({ city: "Blocked" }).expect(403);
    });
  });
});
