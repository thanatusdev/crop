import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The remote operator's own procedural note on an exam (`PATCH /queue/:id/teleoperation-notes`)
 * -- the mirror image of `queue-exam-details.e2e.spec.ts`'s nursing form: same `QueueEntry` row,
 * opposite authorization boundary. What a schema read alone wouldn't prove:
 *
 *  1. The operator side may write it; the nursing side may not, and vice versa for the
 *     nurse's own exam-details fields -- the two write paths must never cross.
 *  2. It round-trips through PATCH -> GET.
 *  3. A DONE/CANCELLED entry can't be edited -- history stays history, the identical rule
 *     `assertDetailsEditable` already enforces for the nurse's own fields.
 *  4. A contracted operator outside their agreement's scope is refused.
 *  5. The audit row carries no note content, only which field changed.
 */
describe("Queue entry teleoperation notes (the remote operator's own procedural note)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let clinicId: string;
  let adminToken: string;
  let nurseToken: string;
  let operatorToken: string;
  let equipmentId: string;
  let queueEntryId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const clinic = await createTenant(prisma, `TeleopNotes-${crypto.randomUUID()}`);
    clinicId = clinic.id;
    adminToken = (await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.NURSING, emailPrefix: "teleop-nurse" })).accessToken;
    operatorToken = (
      await createContractedOperator(app, prisma, { clinicTenantId: clinicId, role: UserRole.OPERATOR, emailPrefix: "teleop-operator" })
    ).accessToken;

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Teleop-Notes-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    equipmentId = equipmentRes.body.id;
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });
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

  it("lets the operator write the note, refuses the nurse, and round-trips through GET", async () => {
    queueEntryId = await createQueueEntry("Teleop-Patient-A");

    const nurseAttempt = await http
      .patch(`/queue/${queueEntryId}/teleoperation-notes`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ teleoperationNotes: "Nurse should not be able to write this." })
      .expect(403);
    expect(nurseAttempt.body.code).toBe("FORBIDDEN");

    await http
      .patch(`/queue/${queueEntryId}/teleoperation-notes`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ teleoperationNotes: "Exame realizado com contraste iodado não-iônico 80ml. Sem sinais de extravasamento." })
      .expect(204);

    const entry = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(entry.body.teleoperationNotes).toBe("Exame realizado com contraste iodado não-iônico 80ml. Sem sinais de extravasamento.");
    // The nurse's own field is untouched by the operator's write -- the two must never cross.
    expect(entry.body.preparationNotes).toBeNull();
  });

  it("refuses to edit a DONE queue entry's teleoperation notes -- history stays history", async () => {
    queueEntryId = await createQueueEntry("Teleop-Patient-B");
    await http.post(`/queue/${queueEntryId}/status`).set("Authorization", `Bearer ${operatorToken}`).send({ status: "CANCELLED" }).expect(204);

    const res = await http
      .patch(`/queue/${queueEntryId}/teleoperation-notes`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ teleoperationNotes: "Too late." })
      .expect(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("refuses a contracted operator writing a note on equipment outside their agreement's scope", async () => {
    // A second unit/equipment this clinic owns, created after the operator's own default
    // grant -- see createContractedOperator's own docstring on why a unit created afterwards
    // is never retroactively covered.
    const me = await http.get("/auth/me").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const secondUnit = await http
      .post("/units")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `Teleop-Ungranted-${crypto.randomUUID().slice(0, 8)}`,
        establishmentType: "LABORATORY",
        technicalManagerId: me.body.id,
        declaredModalities: ["CT"],
        zipCode: "01310-100",
        street: "Rua Teste",
        number: "1",
        district: "Centro",
        city: "São Paulo",
        state: "SP",
      })
      .expect(201);
    const secondEquipment = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Teleop-Ungranted-CT", unitId: secondUnit.body.id }))
      .expect(201);
    const secondEntry = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId: secondEquipment.body.id, patientFirstName: "Teleop-Patient-C" })
      .expect(201);

    const res = await http
      .patch(`/queue/${secondEntry.body.id}/teleoperation-notes`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ teleoperationNotes: "Should be refused." })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("audits the write with the changed field name only, never the note's own content", async () => {
    queueEntryId = await createQueueEntry("Teleop-Patient-D");
    await http
      .patch(`/queue/${queueEntryId}/teleoperation-notes`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ teleoperationNotes: "Contraste administrado sem intercorrências." })
      .expect(204);

    const auditRes = await http.get("/audit?limit=500").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const row = auditRes.body.find(
      (e: { action: string; resourceId: string }) => e.action === "QUEUE_ENTRY_UPDATED" && e.resourceId === queueEntryId
    );
    expect(row).toBeTruthy();
    expect(row.details.changedFields).toEqual(["teleoperationNotes"]);
    expect(JSON.stringify(row.details)).not.toContain("Contraste administrado");
  });
});
