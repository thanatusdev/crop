import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * The queue module had ZERO tenant checks anywhere -- not in the controller, not in any
 * command/query handler, not even a role guard -- and zero test coverage, which is exactly
 * why this went unnoticed. Any authenticated user, any tenant, any role, could create, list
 * (patient first names included), or transition another tenant's patient queue purely by
 * knowing or guessing an equipmentId/queueEntryId. Fixed by adding the same
 * `belongsToTenant` check every other module in this codebase already has. See
 * docs/architecture.md.
 */
describe("Queue: multi-tenant isolation", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let alphaAdminToken: string;
  let betaOperatorToken: string;
  let alphaEquipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const alpha = await createTenant(prisma, `Queue-Alpha-${crypto.randomUUID()}`);
    const beta = await createTenant(prisma, `Queue-Beta-${crypto.randomUUID()}`);

    alphaAdminToken = (await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    betaOperatorToken = (await createLoggedInUser(app, { tenantId: beta.id, role: UserRole.OPERATOR })).accessToken;

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ name: "Queue-Test-MRI", pikvmHost: "https://192.0.2.1", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(201);
    alphaEquipmentId = equipmentRes.body.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("rejects a cross-tenant attempt to create a queue entry on another tenant's equipment", async () => {
    const res = await http
      .post("/queue")
      .set("Authorization", `Bearer ${betaOperatorToken}`)
      .send({ equipmentId: alphaEquipmentId, patientFirstName: "Attacker-Planted-Patient" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rejects a cross-tenant attempt to list another tenant's patient queue", async () => {
    // Alpha creates a legitimate entry first, so there's something a leak *could* expose.
    await http
      .post("/queue")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ equipmentId: alphaEquipmentId, patientFirstName: "RealPatient" })
      .expect(201);

    const res = await http
      .get(`/queue?equipmentId=${alphaEquipmentId}`)
      .set("Authorization", `Bearer ${betaOperatorToken}`)
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rejects a cross-tenant attempt to transition another tenant's queue entry status", async () => {
    const createRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ equipmentId: alphaEquipmentId, patientFirstName: "AnotherRealPatient" })
      .expect(201);

    const res = await http
      .post(`/queue/${createRes.body.id}/status`)
      .set("Authorization", `Bearer ${betaOperatorToken}`)
      .send({ status: "CANCELLED" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    // Confirm the attack didn't work, not just that it returned 403.
    const listRes = await http
      .get(`/queue?equipmentId=${alphaEquipmentId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .expect(200);
    const entry = listRes.body.find((e: { id: string }) => e.id === createRes.body.id);
    expect(entry.status).toBe("WAITING");
  });

  it("still lets the owning tenant create, list, and transition its own queue entries, and audits both writes", async () => {
    const createRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ equipmentId: alphaEquipmentId, patientFirstName: "Owned-Patient" })
      .expect(201);

    await http
      .get(`/queue?equipmentId=${alphaEquipmentId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .expect(200);

    await http
      .post(`/queue/${createRes.body.id}/status`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ status: "IN_PROGRESS" })
      .expect(201);

    const auditRes = await http
      .get(`/audit?limit=200`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .expect(200);
    const actions = auditRes.body
      .filter((e: { resourceId: string }) => e.resourceId === createRes.body.id)
      .map((e: { action: string }) => e.action);
    expect(actions).toContain("QUEUE_ENTRY_CREATED");
    expect(actions).toContain("QUEUE_ENTRY_UPDATED");

    // PHI never leaks into the audit trail's own details.
    const createdEvent = auditRes.body.find(
      (e: { resourceId: string; action: string }) => e.resourceId === createRes.body.id && e.action === "QUEUE_ENTRY_CREATED"
    );
    expect(JSON.stringify(createdEvent.details)).not.toContain("Owned-Patient");
  });
});
