import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * `GET /queue/:id/timeline` -- the nursing screen's per-exam activity panel. See
 * `QueueTimelineEntrySchema`'s own docstring for why this is a resource-scoped route on
 * `QueueController` rather than a widening of `AuditController`'s `@Roles` (which
 * deliberately excludes NURSING). What a schema/handler read alone wouldn't prove:
 *
 *  1. NURSING can read this route -- and, in the same breath, still gets 403 from the real
 *     `GET /audit` -- proving the two are genuinely independent gates, not one relaxed rule.
 *  2. It returns only this one entry's own rows (tenant-isolated, and never another queue
 *     entry's), with actor names resolved rather than raw ids.
 *  3. A QUEUE_REORDERED row -- audited under the *equipment's* id, not this patient's --
 *     never appears here, exactly as documented.
 *  4. No hash-chain fields (seq/hash/prevHash) leak into this narrower shape.
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

describe("Queue entry timeline (nursing per-exam activity panel)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let adminToken: string;
  let nurseToken: string;
  let otherTenantNurseToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `QueueTimeline-${crypto.randomUUID()}`);
    const otherTenant = await createTenant(prisma, `QueueTimelineOther-${crypto.randomUUID()}`);

    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (
      await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.NURSING, emailPrefix: "nurse", firstName: "Camila", lastName: "Rocha" })
    ).accessToken;
    otherTenantNurseToken = (
      await createLoggedInUser(app, { tenantId: otherTenant.id, role: UserRole.NURSING, emailPrefix: "other-nurse" })
    ).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Timeline-CT-1");
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

  it("lists this entry's own preparation/details actions, newest first, with the actor's real name", async () => {
    const queueEntryId = await createQueueEntry("Timeline-Patient");

    await http.post(`/queue/${queueEntryId}/preparation`).set("Authorization", `Bearer ${nurseToken}`).send({ status: "POSITIONED" }).expect(204);
    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({ fastingConfirmed: true }).expect(204);

    const res = await http.get(`/queue/${queueEntryId}/timeline`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    const actions = res.body.map((e: { action: string }) => e.action);
    expect(actions).toContain("PATIENT_POSITIONED");
    expect(actions).toContain("QUEUE_ENTRY_UPDATED");
    // Newest first.
    expect(actions.indexOf("QUEUE_ENTRY_UPDATED")).toBeLessThan(actions.indexOf("PATIENT_POSITIONED"));
    // The two nurse-driven rows are attributed to her; QUEUE_ENTRY_CREATED (from
    // createQueueEntry's own adminToken call) is deliberately excluded from this
    // assertion -- its actor is the CLINIC_ADMIN fixture, not the nurse.
    const nurseRows = res.body.filter((e: { action: string }) => e.action === "PATIENT_POSITIONED" || e.action === "QUEUE_ENTRY_UPDATED");
    expect(nurseRows.every((e: { actorName: string | null }) => e.actorName === "Camila Rocha")).toBe(true);
  });

  it("has no hash-chain fields", async () => {
    const queueEntryId = await createQueueEntry("Timeline-Shape-Patient");
    await http.post(`/queue/${queueEntryId}/preparation`).set("Authorization", `Bearer ${nurseToken}`).send({ status: "POSITIONED" }).expect(204);

    const res = await http.get(`/queue/${queueEntryId}/timeline`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const entry of res.body) {
      expect(Object.keys(entry).sort()).toEqual(["action", "actorName", "timestamp"]);
    }
  });

  it("never includes a QUEUE_REORDERED row -- audited under the equipment's id, not this patient's", async () => {
    // A fresh room, not the shared `equipmentId` every other test in this file also adds
    // WAITING patients to -- ReorderQueueHandler requires orderedIds to exactly match the
    // room's *entire* current WAITING set, which by this point in the file is more than
    // just these two.
    const reorderEquipmentId = await createOnlineEquipment(http, adminToken, prisma, "Timeline-Reorder-CT");
    const createOnReorderEquipment = async (name: string) => {
      const res = await http.post("/queue").set("Authorization", `Bearer ${adminToken}`).send({ equipmentId: reorderEquipmentId, patientFirstName: name }).expect(201);
      return res.body.id as string;
    };
    const a = await createOnReorderEquipment("Reorder-Timeline-A");
    const b = await createOnReorderEquipment("Reorder-Timeline-B");

    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId: reorderEquipmentId, orderedIds: [b, a] })
      .expect(204);

    const res = await http.get(`/queue/${a}/timeline`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(res.body.map((e: { action: string }) => e.action)).not.toContain("QUEUE_REORDERED");
  });

  it("never mixes in another queue entry's own rows", async () => {
    const a = await createQueueEntry("Isolation-Timeline-A");
    const b = await createQueueEntry("Isolation-Timeline-B");
    await http.post(`/queue/${a}/preparation`).set("Authorization", `Bearer ${nurseToken}`).send({ status: "POSITIONED" }).expect(204);
    await http.post(`/queue/${b}/preparation`).set("Authorization", `Bearer ${nurseToken}`).send({ status: "POSITIONED" }).expect(204);

    const res = await http.get(`/queue/${a}/timeline`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    // Only a's own creation + positioning rows -- b's own PATIENT_POSITIONED for a
    // *different* patient must not leak in just because it shares an equipment/action.
    expect(res.body.length).toBe(2);
  });

  it("rejects a cross-tenant nurse's attempt to read another tenant's timeline", async () => {
    const queueEntryId = await createQueueEntry("Cross-Tenant-Timeline-Patient");

    const res = await http.get(`/queue/${queueEntryId}/timeline`).set("Authorization", `Bearer ${otherTenantNurseToken}`).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  // The whole point of this route: NURSING reads it here, but still cannot read the real
  // audit trail -- two genuinely independent gates, not this route quietly relaxing the
  // other one.
  it("NURSING can read the timeline but still gets 403 from GET /audit itself", async () => {
    const queueEntryId = await createQueueEntry("Independent-Gates-Patient");
    await http.post(`/queue/${queueEntryId}/preparation`).set("Authorization", `Bearer ${nurseToken}`).send({ status: "POSITIONED" }).expect(204);

    await http.get(`/queue/${queueEntryId}/timeline`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    const auditRes = await http.get("/audit").set("Authorization", `Bearer ${nurseToken}`).expect(403);
    expect(auditRes.body.code).toBe("FORBIDDEN");
  });
});
