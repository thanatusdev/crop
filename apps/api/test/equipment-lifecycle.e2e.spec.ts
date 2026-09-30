import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * Equipment lifecycle parity: found via a full backend<->frontend coverage audit that
 * equipment only ever had "create" -- Users got lock/unlock, Tenants just got
 * deactivate/reactivate, but equipment had no edit and no manual status override at all.
 * `EquipmentStatus.MAINTENANCE` existed in the shared enum from the start but was never
 * settable by anything. This closes that gap: PATCH /equipment/:id (edit) and
 * POST /equipment/:id/maintenance[/clear] (manual status override), both
 * PLATFORM_ADMIN/CLINIC_ADMIN-gated and tenant-isolated the same way every other equipment
 * route already is.
 */
describe("Equipment lifecycle: edit and maintenance mode", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;
  let adminToken: string;
  let operatorToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    tenantId = (await createTenant(prisma, `EqLifecycle-${crypto.randomUUID()}`)).id;
    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
    operatorToken = (await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATOR, emailPrefix: "eq-lifecycle-op" })).accessToken;

    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Lifecycle-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    equipmentId = res.body.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("edits equipment settings, and the response reflects the change (host/user round-trip, but never the password)", async () => {
    const res = await http
      .patch(`/equipment/${equipmentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Lifecycle-MRI-Renamed", pikvmHost: "https://192.0.2.2" })
      .expect(200);

    expect(res.body.name).toBe("Lifecycle-MRI-Renamed");
    expect(res.body.pikvmHost).toBe("https://192.0.2.2");
    expect(res.body).not.toHaveProperty("pikvmPassword");
  });

  it("leaves the stored password unchanged when omitted, and actually changes it when provided", async () => {
    const before = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });

    await http.patch(`/equipment/${equipmentId}`).set("Authorization", `Bearer ${adminToken}`).send({ name: "No password change" }).expect(200);
    const afterNoop = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
    expect(afterNoop.pikvmPasswordCiphertext).toBe(before.pikvmPasswordCiphertext);

    await http
      .patch(`/equipment/${equipmentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pikvmPassword: "BrandNewPassword456!" })
      .expect(200);
    const afterChange = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
    expect(afterChange.pikvmPasswordCiphertext).not.toBe(before.pikvmPasswordCiphertext);
  });

  it("rejects an OPERATOR editing equipment (CLINIC_ADMIN/PLATFORM_ADMIN only)", async () => {
    await http.patch(`/equipment/${equipmentId}`).set("Authorization", `Bearer ${operatorToken}`).send({ name: "Blocked" }).expect(403);
  });

  it("rejects editing another tenant's equipment", async () => {
    const otherTenantId = (await createTenant(prisma, `EqLifecycle-Other-${crypto.randomUUID()}`)).id;
    const otherAdminToken = (
      await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.CLINIC_ADMIN, emailPrefix: "eq-lifecycle-other-admin" })
    ).accessToken;

    const res = await http
      .patch(`/equipment/${equipmentId}`)
      .set("Authorization", `Bearer ${otherAdminToken}`)
      .send({ name: "Cross-tenant-attempt" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("enters and clears maintenance mode, idempotently, and blocks starting a session while in maintenance", async () => {
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });

    await http.post(`/equipment/${equipmentId}/maintenance`).set("Authorization", `Bearer ${adminToken}`).expect(204);
    let row = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
    expect(row.status).toBe("MAINTENANCE");

    // Idempotent: entering maintenance again while already there is a no-op, not an error.
    await http.post(`/equipment/${equipmentId}/maintenance`).set("Authorization", `Bearer ${adminToken}`).expect(204);

    // A session can't be started against MAINTENANCE equipment -- same "must be ONLINE" rule
    // that already blocks OFFLINE/DEGRADED equipment, no special-casing needed for this.
    const sessionAttempt = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId })
      .expect(409);
    expect(sessionAttempt.body.code).toBe("CONFLICT");

    await http.post(`/equipment/${equipmentId}/maintenance/clear`).set("Authorization", `Bearer ${adminToken}`).expect(204);
    row = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
    // Reverts to OFFLINE, not directly to ONLINE -- see ClearMaintenanceHandler's own comment
    // for why (no real health check happens synchronously here).
    expect(row.status).toBe("OFFLINE");

    // Idempotent the other direction too: clearing maintenance that's already cleared is a
    // no-op, doesn't e.g. reset an unrelated ONLINE status back to OFFLINE.
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });
    await http.post(`/equipment/${equipmentId}/maintenance/clear`).set("Authorization", `Bearer ${adminToken}`).expect(204);
    row = await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
    expect(row.status).toBe("ONLINE");
  });

  it("rejects an OPERATOR toggling maintenance mode", async () => {
    await http.post(`/equipment/${equipmentId}/maintenance`).set("Authorization", `Bearer ${operatorToken}`).expect(403);
  });

  it("audits every edit and maintenance transition under EQUIPMENT_UPDATED, attributing the acting admin", async () => {
    await http.patch(`/equipment/${equipmentId}`).set("Authorization", `Bearer ${adminToken}`).send({ name: "Audited-Rename" }).expect(200);
    await http.post(`/equipment/${equipmentId}/maintenance`).set("Authorization", `Bearer ${adminToken}`).expect(204);
    await http.post(`/equipment/${equipmentId}/maintenance/clear`).set("Authorization", `Bearer ${adminToken}`).expect(204);

    const logs = await prisma.auditLog.findMany({ where: { resourceId: equipmentId, action: "EQUIPMENT_UPDATED" } });
    expect(logs.length).toBeGreaterThanOrEqual(3);
    // The two maintenance-toggle rows must be attributed to the acting admin, not null/system
    // -- distinguishing this from PiKvmHealthPoller's own automatic (userId: null) updates.
    const maintenanceLogs = logs.filter(
      (l) => (l.details as { newStatus?: string }).newStatus === "MAINTENANCE" || (l.details as { newStatus?: string }).newStatus === "OFFLINE"
    );
    expect(maintenanceLogs.every((l) => l.userId !== null)).toBe(true);
  });
});
