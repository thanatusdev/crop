import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The equipment *registry*: a device's clinical identity (what exam it performs, who made it,
 * which room it stands in) and its retirement from service, as opposed to
 * `equipment-lifecycle.e2e.spec.ts`, which covers editing its teleoperation config and its
 * maintenance flag.
 *
 * Two things here are worth spelling out, because both are cases where the obvious
 * implementation is silently wrong:
 *
 *  1. The clinical columns are nullable in Postgres (rows predating this feature have no
 *     honest value for them), so nothing at the database level requires a brand or a serial.
 *     The *only* thing keeping new rows out of that null set is the request schema. These
 *     tests assert the API actually rejects an incomplete registration, because a regression
 *     there would not fail anywhere else.
 *  2. Deactivation cannot be expressed as an `EquipmentStatus`, because PiKvmHealthPoller
 *     rewrites `status` for every non-maintenance device every 10 seconds -- a retired scanner
 *     would come back ONLINE by itself. It is a separate `deactivatedAt` column, the poller
 *     skips it, and `isAvailableForSession()` is what stops the frozen status from being
 *     mistaken for availability. The session-rejection test below is the one that would have
 *     caught the original design.
 */
describe("Equipment registry: clinical identity and deactivation", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;
  let adminToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    tenantId = (await createTenant(prisma, `EqRegistry-${crypto.randomUUID()}`)).id;
    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
    operatorToken = (await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATOR, emailPrefix: "eq-registry-op" })).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function register(overrides: Record<string, unknown> = {}) {
    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload(overrides))
      .expect(201);
    return res.body as Record<string, unknown>;
  }

  describe("registration", () => {
    it("persists and returns every clinical identification field", async () => {
      const body = await register({
        name: "Registry-MRI",
        modality: "MRI",
        brand: "Siemens",
        model: "Magnetom Vida 3.0T",
        serialNumber: "SN-REG-0001",
        roomLabel: "Sala RM-01 • Pavimento Térreo",
        installedAt: "2025-12-21",
        aeTitle: "RADLINK_MR01",
        dicomIp: "10.240.12.45",
        dicomPort: 104,
      });

      expect(body).toMatchObject({
        modality: "MRI",
        brand: "Siemens",
        model: "Magnetom Vida 3.0T",
        serialNumber: "SN-REG-0001",
        roomLabel: "Sala RM-01 • Pavimento Térreo",
        aeTitle: "RADLINK_MR01",
        dicomIp: "10.240.12.45",
        dicomPort: 104,
        deactivated: false,
      });
      // Anchored at UTC midnight, so the stored calendar date is the one that was typed
      // regardless of the server's own timezone -- see CalendarDateSchema.
      expect(body.installedAt).toBe("2025-12-21T00:00:00.000Z");
    });

    it("registers without any DICOM details, since this platform never uses them", async () => {
      const body = await register({ name: "Registry-No-DICOM" });
      expect(body.aeTitle).toBeNull();
      expect(body.dicomIp).toBeNull();
      expect(body.dicomPort).toBeNull();
    });

    it.each(["modality", "brand", "model", "serialNumber", "roomLabel", "installedAt"])(
      "rejects a registration with no %s, even though the column itself is nullable",
      async (field) => {
        const payload = equipmentPayload({ name: `Registry-Missing-${field}` });
        delete payload[field];
        await http.post("/equipment").set("Authorization", `Bearer ${adminToken}`).send(payload).expect(400);
      }
    );

    it("rejects an unknown modality", async () => {
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Bad-Modality", modality: "MAMMOGRAPHY" }))
        .expect(400);
    });

    it("rejects an AE Title longer than DICOM's 16-character limit", async () => {
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(equipmentPayload({ name: "Registry-Bad-AE", aeTitle: "A".repeat(17) }))
        .expect(400);
    });

    it("records the serial number in the creation audit entry, so the fleet is traceable to physical devices", async () => {
      const body = await register({ name: "Registry-Audited", serialNumber: "SN-AUDIT-9999" });
      const log = await prisma.auditLog.findFirstOrThrow({
        where: { resourceId: body.id as string, action: "EQUIPMENT_CREATED" },
      });
      expect((log.details as { serialNumber?: string }).serialNumber).toBe("SN-AUDIT-9999");
      // Still never the credentials, for any field added since.
      expect(JSON.stringify(log.details)).not.toContain("Password123!");
    });
  });

  describe("editing clinical fields", () => {
    it("updates one clinical field without resending the rest", async () => {
      const created = await register({ name: "Registry-Editable", roomLabel: "Sala Antiga" });
      const res = await http
        .patch(`/equipment/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ roomLabel: "Sala TC-02 • 1º Andar" })
        .expect(200);

      expect(res.body.roomLabel).toBe("Sala TC-02 • 1º Andar");
      // Untouched fields survive the partial update.
      expect(res.body.brand).toBe("Siemens");
    });

    it("refuses to blank out a clinical field, which would walk the row back into the historical-null set", async () => {
      const created = await register({ name: "Registry-No-Blanking" });
      await http
        .patch(`/equipment/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ brand: null })
        .expect(400);
      await http.patch(`/equipment/${created.id as string}`).set("Authorization", `Bearer ${adminToken}`).send({ brand: "   " }).expect(400);
    });

    it("does allow clearing the DICOM fields, since 'no PACS entry after all' is a real correction", async () => {
      const created = await register({ name: "Registry-Clear-DICOM", aeTitle: "RADLINK_X1", dicomPort: 104 });
      const res = await http
        .patch(`/equipment/${created.id as string}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ aeTitle: null, dicomIp: null, dicomPort: null })
        .expect(200);
      expect(res.body.aeTitle).toBeNull();
      expect(res.body.dicomPort).toBeNull();
    });
  });

  describe("deactivation", () => {
    it("retires equipment and returns it, idempotently, without ever deleting the row", async () => {
      const created = await register({ name: "Registry-Retire" });
      const id = created.id as string;

      const deactivated = await http.post(`/equipment/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      expect(deactivated.body.deactivated).toBe(true);
      expect(await prisma.equipment.findUnique({ where: { id } })).not.toBeNull();

      // Idempotent: a double-click, or a click against a stale list, is a no-op rather than an
      // error or a toggle back.
      const again = await http.post(`/equipment/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      expect(again.body.deactivated).toBe(true);

      const reactivated = await http.post(`/equipment/${id}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      expect(reactivated.body.deactivated).toBe(false);
    });

    /**
     * The test that justifies `deactivatedAt` existing as its own column.
     *
     * The equipment is forced ONLINE first, exactly as a healthy scanner would be, and is then
     * retired. Its `status` stays ONLINE afterwards -- the poller skips deactivated rows, so
     * nothing ever corrects it. A status-only availability check (which is what
     * StartSessionHandler did before this feature) would therefore happily open a session on a
     * decommissioned device. This asserts it does not.
     */
    it("refuses to start a session on retired equipment whose frozen status still says ONLINE", async () => {
      const created = await register({ name: "Registry-Retired-But-Online" });
      const id = created.id as string;
      await prisma.equipment.update({ where: { id }, data: { status: "ONLINE" } });

      await http.post(`/equipment/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);

      const frozen = await prisma.equipment.findUniqueOrThrow({ where: { id } });
      expect(frozen.status).toBe("ONLINE");
      expect(frozen.deactivatedAt).not.toBeNull();

      const attempt = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: id }).expect(409);
      expect(attempt.body.code).toBe("CONFLICT");
      expect(attempt.body.message).toContain("deactivated");

      // And it becomes startable again once returned to service, proving the refusal came from
      // the deactivation and not from some unrelated state this test left behind.
      await http.post(`/equipment/${id}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      await prisma.equipment.update({ where: { id }, data: { status: "ONLINE" } });
      await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: id }).expect(201);
    });

    it("audits deactivation and reactivation as their own actions, recording the last observed health", async () => {
      const created = await register({ name: "Registry-Audit-Retire" });
      const id = created.id as string;
      await prisma.equipment.update({ where: { id }, data: { status: "DEGRADED" } });

      await http.post(`/equipment/${id}/deactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);
      await http.post(`/equipment/${id}/reactivate`).set("Authorization", `Bearer ${adminToken}`).expect(201);

      const deactivatedLog = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: id, action: "EQUIPMENT_DEACTIVATED" } });
      expect((deactivatedLog.details as { lastKnownStatus?: string }).lastKnownStatus).toBe("DEGRADED");
      expect(deactivatedLog.userId).not.toBeNull();

      await prisma.auditLog.findFirstOrThrow({ where: { resourceId: id, action: "EQUIPMENT_REACTIVATED" } });
    });

    it("rejects an OPERATOR retiring equipment", async () => {
      const created = await register({ name: "Registry-Operator-Blocked" });
      await http.post(`/equipment/${created.id as string}/deactivate`).set("Authorization", `Bearer ${operatorToken}`).expect(403);
    });

    it("rejects retiring another tenant's equipment", async () => {
      const created = await register({ name: "Registry-Cross-Tenant" });
      const otherTenantId = (await createTenant(prisma, `EqRegistry-Other-${crypto.randomUUID()}`)).id;
      const otherAdmin = await createLoggedInUser(app, {
        tenantId: otherTenantId,
        role: UserRole.CLINIC_ADMIN,
        emailPrefix: "eq-registry-other",
      });

      const res = await http
        .post(`/equipment/${created.id as string}/deactivate`)
        .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
        .expect(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });
  });
});
