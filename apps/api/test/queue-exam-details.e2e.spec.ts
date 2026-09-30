import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The nurse's "Salvar Alterações deste Paciente" exam-detail form
 * (examDescription/contrastRequired/patientSex/patientWeightKg/scheduledAt/
 * preparationNotes) -- see UpdateQueueEntryDetailsHandler. What a schema read alone
 * wouldn't prove:
 *
 *  1. Every field round-trips through PATCH -> GET.
 *  2. Partial patches leave untouched fields alone; an explicit `null` clears one.
 *  3. A DONE/CANCELLED entry can't be edited -- history stays history.
 *  4. The audit row for this route carries field *names* only, never the clinical values
 *     themselves (weight, notes, sex) -- this route's whole reason to be careful.
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

describe("Queue entry exam details (nursing editable patient/exam fields)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let adminToken: string;
  let nurseToken: string;
  let operatorToken: string;
  let otherTenantNurseToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `QueueDetails-${crypto.randomUUID()}`);
    const otherTenant = await createTenant(prisma, `QueueDetailsOther-${crypto.randomUUID()}`);

    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.NURSING, emailPrefix: "nurse" }))
      .accessToken;
    operatorToken = (
      await createContractedOperator(app, prisma, { clinicTenantId: tenant.id, role: UserRole.OPERATOR, emailPrefix: "operator" })
    ).accessToken;
    otherTenantNurseToken = (
      await createLoggedInUser(app, { tenantId: otherTenant.id, role: UserRole.NURSING, emailPrefix: "other-nurse" })
    ).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Details-CT-1");
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

  it("round-trips every exam-detail field through PATCH -> GET", async () => {
    const queueEntryId = await createQueueEntry("Full-Details-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        examDescription: "TC Tórax c/ Contraste",
        contrastRequired: true,
        patientSex: "FEMALE",
        patientWeightKg: 65,
        scheduledAt: "2026-09-28T08:00:00.000Z",
        preparationNotes: "Jejum de 8h confirmado.",
      })
      .expect(204);

    const res = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(res.body.examDescription).toBe("TC Tórax c/ Contraste");
    expect(res.body.contrastRequired).toBe(true);
    expect(res.body.patientSex).toBe("FEMALE");
    expect(res.body.patientWeightKg).toBe(65);
    expect(res.body.scheduledAt).toBe("2026-09-28T08:00:00.000Z");
    expect(res.body.preparationNotes).toBe("Jejum de 8h confirmado.");
  });

  it("a partial patch leaves untouched fields alone", async () => {
    const queueEntryId = await createQueueEntry("Partial-Patch-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ examDescription: "TC Abdome Total", patientWeightKg: 58 })
      .expect(204);

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ preparationNotes: "Acesso venoso pérvio." })
      .expect(204);

    const res = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(res.body.examDescription).toBe("TC Abdome Total");
    expect(res.body.patientWeightKg).toBe(58);
    expect(res.body.preparationNotes).toBe("Acesso venoso pérvio.");
  });

  it("an explicit null clears a previously-set field", async () => {
    const queueEntryId = await createQueueEntry("Clear-Field-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientWeightKg: 70 })
      .expect(204);

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientWeightKg: null })
      .expect(204);

    const res = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(res.body.patientWeightKg).toBeNull();
  });

  it("rejects an empty patch, an out-of-range weight, and notes over the length limit", async () => {
    const queueEntryId = await createQueueEntry("Invalid-Patch-Patient");

    await http.patch(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).send({}).expect(400);
    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientWeightKg: 0 })
      .expect(400);
    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ preparationNotes: "a".repeat(2001) })
      .expect(400);
  });

  it("rejects editing a DONE queue entry's exam details", async () => {
    const queueEntryId = await createQueueEntry("Done-Patient");
    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId, queueEntryId })
      .expect(201);
    await http.post(`/sessions/${sessionRes.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);

    const res = await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ preparationNotes: "Too late" })
      .expect(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("rejects a cross-tenant nurse's attempt to edit another tenant's exam details", async () => {
    const queueEntryId = await createQueueEntry("Cross-Tenant-Details-Patient");

    const res = await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${otherTenantNurseToken}`)
      .send({ preparationNotes: "Should not apply" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    const unchanged = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(unchanged.body.preparationNotes).toBeNull();
  });

  it("rejects OPERATOR editing exam details, and audits the denial", async () => {
    const queueEntryId = await createQueueEntry("Op-Denied-Details-Patient");

    const res = await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ preparationNotes: "Should not apply" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    const auditRes = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const denied = auditRes.body.find(
      (e: { action: string; details: { path?: string } }) =>
        e.action === "PERMISSION_DENIED" && e.details.path === `/queue/${queueEntryId}`
    );
    expect(denied).toBeTruthy();
    expect(denied.details.requiredRoles).toContain("NURSING");
  });

  it("audits a details update with field names only -- never the note text, weight, or sex value", async () => {
    const queueEntryId = await createQueueEntry("Audit-PHI-Patient");

    await http
      .patch(`/queue/${queueEntryId}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientWeightKg: 82, patientSex: "MALE", preparationNotes: "Claustrofobia leve, orientado." })
      .expect(204);

    const auditRes = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const event = auditRes.body.find(
      (e: { action: string; resourceId: string }) => e.action === "QUEUE_ENTRY_UPDATED" && e.resourceId === queueEntryId
    );
    expect(event).toBeTruthy();
    expect(event.details.changedFields.sort()).toEqual(["patientSex", "patientWeightKg", "preparationNotes"]);
    // The strongest version of "no PHI in the audit row" isn't a substring search (a raw
    // weight/uuid digit can coincidentally appear inside another field's value) -- it's
    // asserting the details object has exactly these two keys, neither of which is a
    // clinical value.
    expect(Object.keys(event.details).sort()).toEqual(["changedFields", "equipmentId"]);
    expect(JSON.stringify(event.details)).not.toContain("Claustrofobia");
    expect(JSON.stringify(event.details)).not.toContain("Audit-PHI-Patient");
  });
});
