import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The nurse's three quick-action buttons ("Paciente Posicionado" / "Injetado" / "Paciente
 * Liberado") -- see PreparationStatus in packages/shared/src/enums.ts. Three things this
 * suite exists to prove that a schema/domain read alone wouldn't:
 *
 *  1. INJECTED is genuinely skippable (POSITIONED -> RELEASED), not just documented as such.
 *  2. The release gate is a real cross-aggregate check against the *session's* own status,
 *     not just a same-table domain guard -- release must be blocked while a session started
 *     against this queue entry is ACTIVE, and unblocked the moment it ends.
 *  3. Tenant isolation and role restriction on the write route (@Roles narrower than the
 *     rest of QueueController -- see queue.controller.ts) hold up the same way every other
 *     module's does: 403, unchanged state, and an audited denial.
 */
async function createOnlineEquipment(
  http: ReturnType<typeof request>,
  adminToken: string,
  prisma: ReturnType<typeof testPrisma>,
  name: string
): Promise<string> {
  const res = await http
    .post("/equipment")
    .set("Authorization", `Bearer ${adminToken}`)
    .send(equipmentPayload({ name, pikvmHost: "https://192.0.2.1" }))
    .expect(201);
  await prisma.equipment.update({ where: { id: res.body.id }, data: { status: "ONLINE" } });
  return res.body.id;
}

describe("Patient preparation (nursing quick-action status)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let tenantId: string;
  let adminToken: string;
  let nurseToken: string;
  let operatorToken: string;
  let localItToken: string;
  let otherTenantNurseToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `PatientPrep-${crypto.randomUUID()}`);
    tenantId = tenant.id;
    const otherTenant = await createTenant(prisma, `PatientPrepOther-${crypto.randomUUID()}`);

    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (await createLoggedInUser(app, { tenantId, role: UserRole.NURSING, emailPrefix: "nurse" })).accessToken;
    operatorToken = (await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATOR, emailPrefix: "operator" })).accessToken;
    localItToken = (await createLoggedInUser(app, { tenantId, role: UserRole.LOCAL_IT, emailPrefix: "local-it" })).accessToken;
    otherTenantNurseToken = (
      await createLoggedInUser(app, { tenantId: otherTenant.id, role: UserRole.NURSING, emailPrefix: "other-nurse" })
    ).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "PatientPrep-MRI");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function createQueueEntry(patientFirstName: string): Promise<string> {
    const res = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId, patientFirstName })
      .expect(201);
    return res.body.id;
  }

  it("lets a nurse position a WAITING patient, then release them directly -- INJECTED is skippable", async () => {
    const queueEntryId = await createQueueEntry("Skip-Injected-Patient");

    await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "POSITIONED" })
      .expect(204);

    const afterPositioned = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(afterPositioned.body.preparationStatus).toBe("POSITIONED");
    expect(afterPositioned.body.positionedAt).not.toBeNull();
    expect(afterPositioned.body.injectedAt).toBeNull();

    // No session was ever started against this queue entry -- release must not require one.
    await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "RELEASED" })
      .expect(204);

    const afterReleased = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(afterReleased.body.preparationStatus).toBe("RELEASED");
    expect(afterReleased.body.injectedAt).toBeNull(); // still never set -- confirms the skip, not a silent backfill
    expect(afterReleased.body.releasedAt).not.toBeNull();
  });

  it("rejects NOT_STARTED -> INJECTED, and rejects any transition out of RELEASED", async () => {
    const queueEntryId = await createQueueEntry("Invalid-Transition-Patient");

    const skipToInjected = await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "INJECTED" })
      .expect(409);
    expect(skipToInjected.body.code).toBe("CONFLICT");

    await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "POSITIONED" })
      .expect(204);
    await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "RELEASED" })
      .expect(204);

    const outOfReleased = await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "POSITIONED" })
      .expect(409);
    expect(outOfReleased.body.code).toBe("CONFLICT");
  });

  it("blocks release while the exam's session is ACTIVE, and unblocks it once the session ends", async () => {
    const queueRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId, patientFirstName: "Active-Session-Patient" })
      .expect(201);
    const queueEntryId = queueRes.body.id;

    await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "POSITIONED" })
      .expect(204);

    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId, queueEntryId })
      .expect(201);
    const sessionId = sessionRes.body.id;

    const blocked = await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "RELEASED" })
      .expect(409);
    expect(blocked.body.code).toBe("CONFLICT");

    // The attack (well, the premature action) didn't work -- re-read, don't just trust the 409.
    const stillPositioned = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(stillPositioned.body.preparationStatus).toBe("POSITIONED");
    expect(stillPositioned.body.releasedAt).toBeNull();

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);

    await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "RELEASED" })
      .expect(204);

    const released = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(released.body.preparationStatus).toBe("RELEASED");

    // The audit row for this release must correlate to the session it waited on.
    const auditRes = await http.get(`/audit?limit=200`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const releasedEvent = auditRes.body.find(
      (e: { resourceId: string; action: string }) => e.resourceId === queueEntryId && e.action === "PATIENT_RELEASED"
    );
    expect(releasedEvent).toBeTruthy();
    expect(releasedEvent.sessionId).toBe(sessionId);
    expect(JSON.stringify(releasedEvent.details)).not.toContain("Active-Session-Patient");
  });

  it("rejects a cross-tenant nurse's attempt to update another tenant's patient preparation status", async () => {
    const queueEntryId = await createQueueEntry("Cross-Tenant-Patient");

    const res = await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${otherTenantNurseToken}`)
      .send({ status: "POSITIONED" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    const unchanged = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(unchanged.body.preparationStatus).toBe("NOT_STARTED");
  });

  it("rejects a cross-tenant attempt to read another tenant's queue entry", async () => {
    const queueEntryId = await createQueueEntry("Cross-Tenant-Read-Patient");

    const res = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${otherTenantNurseToken}`).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it.each([
    ["OPERATOR", () => operatorToken],
    ["LOCAL_IT", () => localItToken],
  ])("rejects %s writing a patient preparation status, and audits the denial", async (roleName, getToken) => {
    const queueEntryId = await createQueueEntry(`${roleName}-Denied-Patient`);

    const res = await http
      .post(`/queue/${queueEntryId}/preparation`)
      .set("Authorization", `Bearer ${getToken()}`)
      .send({ status: "POSITIONED" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    const unchanged = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(unchanged.body.preparationStatus).toBe("NOT_STARTED");

    const auditRes = await http.get(`/audit?limit=200`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const denied = auditRes.body.find(
      (e: { action: string; details: { path?: string } }) =>
        e.action === "PERMISSION_DENIED" && e.details.path === `/queue/${queueEntryId}/preparation`
    );
    expect(denied).toBeTruthy();
    expect(denied.details.requiredRoles).toContain("NURSING");
  });
});
