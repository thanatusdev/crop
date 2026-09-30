import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The nurse's structured "Questionário de Segurança & Contraste"
 * (fastingConfirmed/fastingHours/creatinineMgDl/allergyStatus/allergyNotes/contrastVolumeMl)
 * and the exam-detail form's write attribution (detailsUpdatedAt/detailsUpdatedByName) --
 * both via the same `PATCH /queue/:id` the earlier exam-details feature already built. What
 * a schema read alone wouldn't prove:
 *
 *  1. Every questionnaire field round-trips, and an explicit null clears one.
 *  2. The audit row for this route still carries field *names* only -- creatinine,
 *     allergy notes, and the fasting/contrast values are clinical data and must never reach
 *     the audit table, the same rule the original exam-detail fields already follow.
 *  3. `detailsUpdatedAt`/`detailsUpdatedByName` are written on every successful save,
 *     resolved to the *acting* nurse's real name, not a raw user id.
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

describe("Queue safety questionnaire + exam-detail attribution", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let adminToken: string;
  let nurseToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `QueueSafetyQuestionnaire-${crypto.randomUUID()}`);
    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (
      await createLoggedInUser(app, {
        tenantId: tenant.id,
        role: UserRole.NURSING,
        emailPrefix: "nurse",
        firstName: "Camila",
        lastName: "Rocha",
      })
    ).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Questionnaire-CT-1");
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

  it("round-trips every safety-questionnaire field through PATCH -> GET", async () => {
    const queueEntryId = await createQueueEntry("Questionnaire-Full-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        fastingConfirmed: true,
        fastingHours: 6,
        creatinineMgDl: 0.9,
        allergyStatus: "NEGATED",
        allergyNotes: null,
        contrastVolumeMl: 102,
      })
      .expect(204);

    const res = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(res.body.fastingConfirmed).toBe(true);
    expect(res.body.fastingHours).toBe(6);
    expect(res.body.creatinineMgDl).toBe(0.9);
    expect(res.body.allergyStatus).toBe("NEGATED");
    expect(res.body.allergyNotes).toBeNull();
    expect(res.body.contrastVolumeMl).toBe(102);
  });

  it("records an allergy and clears it back to negated", async () => {
    const queueEntryId = await createQueueEntry("Questionnaire-Allergy-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ allergyStatus: "PRESENT", allergyNotes: "Alergia a iodo -- reação cutânea leve em exame anterior." })
      .expect(204);

    const withAllergy = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(withAllergy.body.allergyStatus).toBe("PRESENT");
    expect(withAllergy.body.allergyNotes).toContain("iodo");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ allergyStatus: "NEGATED", allergyNotes: null })
      .expect(204);

    const cleared = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(cleared.body.allergyStatus).toBe("NEGATED");
    expect(cleared.body.allergyNotes).toBeNull();
  });

  it("writes detailsUpdatedAt/detailsUpdatedByName on every successful save, resolved to the acting nurse's real name", async () => {
    const queueEntryId = await createQueueEntry("Attribution-Patient");

    const before = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(before.body.detailsUpdatedAt).toBeNull();
    expect(before.body.detailsUpdatedByName).toBeNull();

    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({ fastingConfirmed: true }).expect(204);

    const after = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(after.body.detailsUpdatedAt).not.toBeNull();
    expect(after.body.detailsUpdatedByName).toBe("Camila Rocha");
  });

  it("rejects out-of-range questionnaire values", async () => {
    const queueEntryId = await createQueueEntry("Questionnaire-Invalid-Patient");

    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({ fastingHours: 73 }).expect(400);
    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({ creatinineMgDl: 21 }).expect(400);
    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({ contrastVolumeMl: -1 }).expect(400);
    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({ allergyStatus: "MAYBE" }).expect(400);
  });

  it("audits a questionnaire update with field names only -- never the creatinine/allergy/contrast values", async () => {
    const queueEntryId = await createQueueEntry("Questionnaire-Audit-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        fastingConfirmed: true,
        fastingHours: 8,
        creatinineMgDl: 1.4,
        allergyStatus: "PRESENT",
        allergyNotes: "Claustrofobia leve",
        contrastVolumeMl: 90,
      })
      .expect(204);

    const auditRes = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const event = auditRes.body.find(
      (e: { action: string; resourceId: string }) => e.action === "QUEUE_ENTRY_UPDATED" && e.resourceId === queueEntryId
    );
    expect(event).toBeTruthy();
    expect(event.details.changedFields.sort()).toEqual(
      ["allergyNotes", "allergyStatus", "contrastVolumeMl", "creatinineMgDl", "fastingConfirmed", "fastingHours"].sort()
    );
    expect(Object.keys(event.details).sort()).toEqual(["changedFields", "equipmentId"]);
    expect(JSON.stringify(event.details)).not.toContain("Claustrofobia");
    expect(JSON.stringify(event.details)).not.toContain("Questionnaire-Audit-Patient");
  });
});
