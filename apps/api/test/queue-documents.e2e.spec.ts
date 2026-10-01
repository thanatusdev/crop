import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The nurse's uploaded exam-order documents (`QueueEntryDocument` -- "Pedido Médico"/"Laudo
 * Anterior"/"Outro") on `POST/GET /queue/:id/documents*`. What a schema read alone wouldn't
 * prove:
 *
 *  1. A byte-exact round trip: upload, list (hydrated on the owning `QueueEntryDto`), and
 *     download all agree on the exact same bytes, filename, mime type, and size.
 *  2. The write/read authorization split this feature's whole design turns on: nurse-side
 *     roles write (upload/remove), gated by `assertDetailsEditable()`; a contracted
 *     *operator* can only ever read, with no such status gate -- a completed exam's order
 *     is still a record worth retrieving.
 *  3. A disallowed mime type is refused before anything is written to disk.
 *  4. Removal is a real hard delete: the row is gone, and so are the bytes -- a second
 *     download attempt 404s, not "the same bytes it already had."
 *  5. The audit rows for both actions carry `kind`/`mimeType` only, never the filename --
 *     the same PHI rule `SendExamMessageHandler` already follows for chat attachments,
 *     because a clinician-chosen filename can itself carry a patient's name.
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

const PDF_BYTES = Buffer.from("%PDF-1.4\nqueue-documents e2e fixture\n%%EOF");

describe("Queue entry documents (the nurse's uploaded Pedido Médico/Laudo Anterior)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let clinicId: string;
  let adminToken: string;
  let nurseToken: string;
  let contractedOperatorToken: string;
  let uncontractedOperatorToken: string;
  let otherTenantNurseToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `QueueDocs-${crypto.randomUUID()}`);
    clinicId = tenant.id;
    const otherTenant = await createTenant(prisma, `QueueDocsOther-${crypto.randomUUID()}`);
    const uncontractedCompany = await createTenant(prisma, `QueueDocsUncontracted-${crypto.randomUUID()}`, "OPERATOR_PROVIDER");

    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.NURSING, emailPrefix: "nurse" })).accessToken;
    contractedOperatorToken = (
      await createContractedOperator(app, prisma, { clinicTenantId: tenant.id, role: UserRole.OPERATOR, emailPrefix: "contracted-op" })
    ).accessToken;
    uncontractedOperatorToken = (
      await createLoggedInUser(app, { tenantId: uncontractedCompany.id, role: UserRole.OPERATOR, emailPrefix: "stranger-op" })
    ).accessToken;
    otherTenantNurseToken = (
      await createLoggedInUser(app, { tenantId: otherTenant.id, role: UserRole.NURSING, emailPrefix: "other-nurse" })
    ).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Docs-CT-1");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function createQueueEntry(patientFirstName: string): Promise<string> {
    const res = await http.post("/queue").set("Authorization", `Bearer ${adminToken}`).send({ equipmentId, patientFirstName }).expect(201);
    return res.body.id;
  }

  it("uploads a PDF, lists it on the queue entry, and lets the nurse download the exact bytes back", async () => {
    const queueEntryId = await createQueueEntry("Doc-Roundtrip-Patient");

    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .field("kind", "LAUDO_ANTERIOR")
      .attach("file", PDF_BYTES, { filename: "laudo-anterior.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(uploadRes.body).toMatchObject({ kind: "LAUDO_ANTERIOR", filename: "laudo-anterior.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length });
    expect(uploadRes.body.uploadedByName).toBeTruthy();
    const documentId = uploadRes.body.id;

    const entryRes = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(entryRes.body.documents).toHaveLength(1);
    expect(entryRes.body.documents[0]).toMatchObject({ id: documentId, kind: "LAUDO_ANTERIOR", filename: "laudo-anterior.pdf" });

    const download = await http.get(`/queue/${queueEntryId}/documents/${documentId}/content`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(Buffer.compare(download.body, PDF_BYTES)).toBe(0);
    expect(download.headers["content-type"]).toContain("application/pdf");
    expect(download.headers["content-disposition"]).toContain("laudo-anterior.pdf");
  });

  it("defaults kind to PEDIDO_MEDICO when the nurse doesn't specify one", async () => {
    const queueEntryId = await createQueueEntry("Doc-Default-Kind-Patient");

    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "pedido.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(uploadRes.body.kind).toBe("PEDIDO_MEDICO");
  });

  it("accepts PNG/JPEG/WEBP too, and rejects a disallowed mime type before writing anything", async () => {
    const queueEntryId = await createQueueEntry("Doc-Mime-Patient");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

    await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", png, { filename: "wristband.png", contentType: "image/png" })
      .expect(201);

    const rejected = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", Buffer.from("#!/bin/sh\necho hi\n"), { filename: "script.sh", contentType: "application/x-sh" })
      .expect(400);
    expect(rejected.body.code).toBe("VALIDATION_ERROR");

    // The rejection didn't also silently drop the one that *should* have gone through.
    const entryRes = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(entryRes.body.documents).toHaveLength(1);
  });

  it("requires a file -- a request with no attachment is refused, not silently accepted as an empty document", async () => {
    const queueEntryId = await createQueueEntry("Doc-NoFile-Patient");
    await http.post(`/queue/${queueEntryId}/documents`).set("Authorization", `Bearer ${nurseToken}`).field("kind", "OUTRO").expect(400);
  });

  it("removes a document: the row and the bytes are both gone -- a second download 404s", async () => {
    const queueEntryId = await createQueueEntry("Doc-Remove-Patient");
    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "to-remove.pdf", contentType: "application/pdf" })
      .expect(201);
    const documentId = uploadRes.body.id;

    await http.post(`/queue/${queueEntryId}/documents/${documentId}/remove`).set("Authorization", `Bearer ${nurseToken}`).expect(204);

    await http.get(`/queue/${queueEntryId}/documents/${documentId}/content`).set("Authorization", `Bearer ${nurseToken}`).expect(404);
    const entryRes = await http.get(`/queue/${queueEntryId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    expect(entryRes.body.documents).toHaveLength(0);
  });

  it("refuses upload and removal once the queue entry is DONE, but still lets it be read", async () => {
    const queueEntryId = await createQueueEntry("Doc-Done-Patient");
    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "before-done.pdf", contentType: "application/pdf" })
      .expect(201);
    const documentId = uploadRes.body.id;

    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${contractedOperatorToken}`)
      .send({ equipmentId, queueEntryId })
      .expect(201);
    await http.post(`/sessions/${sessionRes.body.id}/end`).set("Authorization", `Bearer ${contractedOperatorToken}`).expect(201);

    const uploadAfter = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "after-done.pdf", contentType: "application/pdf" })
      .expect(409);
    expect(uploadAfter.body.code).toBe("CONFLICT");

    const removeAfter = await http.post(`/queue/${queueEntryId}/documents/${documentId}/remove`).set("Authorization", `Bearer ${nurseToken}`).expect(409);
    expect(removeAfter.body.code).toBe("CONFLICT");

    // The one document route with no status gate at all -- a completed exam's order is
    // still a record worth retrieving. See GetQueueDocumentHandler's own docstring.
    await http.get(`/queue/${queueEntryId}/documents/${documentId}/content`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
  });

  it("lets a contracted operator read a document but refuses them write access entirely", async () => {
    const queueEntryId = await createQueueEntry("Doc-Operator-Read-Patient");
    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "operator-read.pdf", contentType: "application/pdf" })
      .expect(201);
    const documentId = uploadRes.body.id;

    const download = await http
      .get(`/queue/${queueEntryId}/documents/${documentId}/content`)
      .set("Authorization", `Bearer ${contractedOperatorToken}`)
      .expect(200);
    expect(Buffer.compare(download.body, PDF_BYTES)).toBe(0);

    await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${contractedOperatorToken}`)
      .attach("file", PDF_BYTES, { filename: "sneaky.pdf", contentType: "application/pdf" })
      .expect(403);
    await http.post(`/queue/${queueEntryId}/documents/${documentId}/remove`).set("Authorization", `Bearer ${contractedOperatorToken}`).expect(403);
  });

  it("refuses a company with no agreement on this clinic at all, the same scope check GetQueueEntryHandler already enforces", async () => {
    const queueEntryId = await createQueueEntry("Doc-Uncontracted-Patient");
    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "scoped-out.pdf", contentType: "application/pdf" })
      .expect(201);

    const res = await http
      .get(`/queue/${queueEntryId}/documents/${uploadRes.body.id}/content`)
      .set("Authorization", `Bearer ${uncontractedOperatorToken}`)
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("refuses a different tenant's nurse entirely -- upload, remove, and read all 403", async () => {
    const queueEntryId = await createQueueEntry("Doc-Cross-Tenant-Patient");
    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "mine.pdf", contentType: "application/pdf" })
      .expect(201);
    const documentId = uploadRes.body.id;

    await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${otherTenantNurseToken}`)
      .attach("file", PDF_BYTES, { filename: "intruder.pdf", contentType: "application/pdf" })
      .expect(403);
    await http.post(`/queue/${queueEntryId}/documents/${documentId}/remove`).set("Authorization", `Bearer ${otherTenantNurseToken}`).expect(403);
    await http.get(`/queue/${queueEntryId}/documents/${documentId}/content`).set("Authorization", `Bearer ${otherTenantNurseToken}`).expect(403);
  });

  it("audits both actions with kind/mimeType only -- never the filename, which can itself carry a patient's name", async () => {
    const queueEntryId = await createQueueEntry("Doc-Audit-PHI-Patient");

    const uploadRes = await http
      .post(`/queue/${queueEntryId}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .field("kind", "OUTRO")
      .attach("file", PDF_BYTES, { filename: "Jose-da-Silva-exame.pdf", contentType: "application/pdf" })
      .expect(201);
    const documentId = uploadRes.body.id;
    await http.post(`/queue/${queueEntryId}/documents/${documentId}/remove`).set("Authorization", `Bearer ${nurseToken}`).expect(204);

    const auditRes = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const attached = auditRes.body.find(
      (e: { action: string; details: { documentId?: string } }) => e.action === "QUEUE_DOCUMENT_ATTACHED" && e.details.documentId === documentId
    );
    const removed = auditRes.body.find(
      (e: { action: string; details: { documentId?: string } }) => e.action === "QUEUE_DOCUMENT_REMOVED" && e.details.documentId === documentId
    );
    expect(attached).toBeTruthy();
    expect(removed).toBeTruthy();
    expect(Object.keys(attached.details).sort()).toEqual(["documentId", "equipmentId", "kind", "mimeType"]);
    expect(Object.keys(removed.details).sort()).toEqual(["documentId", "equipmentId", "kind", "mimeType"]);
    expect(attached.details.kind).toBe("OUTRO");
    expect(attached.details.mimeType).toBe("application/pdf");
    expect(JSON.stringify(attached.details)).not.toContain("Jose-da-Silva");
    expect(JSON.stringify(removed.details)).not.toContain("Jose-da-Silva");
  });

  it("rejects a document id for a real document that belongs to a different queue entry", async () => {
    const queueEntryIdA = await createQueueEntry("Doc-WrongEntry-A");
    const queueEntryIdB = await createQueueEntry("Doc-WrongEntry-B");
    const uploadRes = await http
      .post(`/queue/${queueEntryIdA}/documents`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .attach("file", PDF_BYTES, { filename: "belongs-to-a.pdf", contentType: "application/pdf" })
      .expect(201);
    const documentId = uploadRes.body.id;

    await http.get(`/queue/${queueEntryIdB}/documents/${documentId}/content`).set("Authorization", `Bearer ${nurseToken}`).expect(404);
    await http.post(`/queue/${queueEntryIdB}/documents/${documentId}/remove`).set("Authorization", `Bearer ${nurseToken}`).expect(404);
  });
});
