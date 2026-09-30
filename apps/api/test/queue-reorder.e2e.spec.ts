import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The nurse's drag/arrow "Confirmar Nova Sequência" reorder of one room's WAITING patients
 * (see ReorderQueueHandler / planQueueReorder). What a schema/domain read alone wouldn't
 * prove:
 *
 *  1. A full valid permutation actually renumbers the WAITING entries into contiguous
 *     positions, and leaves IN_PROGRESS/DONE entries' positions completely untouched.
 *  2. The two distinct 409s (a formerly-WAITING patient that moved on vs. a plain stale
 *     view) are both real, and neither one silently reorders anything.
 *  3. A no-op confirm (same order resubmitted) writes no audit row at all.
 *  4. Tenant isolation, role restriction, and PHI-free audit details hold the same way every
 *     other queue write route's do.
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

describe("Queue reorder (nursing priority reordering)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let adminToken: string;
  let nurseToken: string;
  let operatorToken: string;
  let otherTenantNurseToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `QueueReorder-${crypto.randomUUID()}`);
    const otherTenant = await createTenant(prisma, `QueueReorderOther-${crypto.randomUUID()}`);

    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.NURSING, emailPrefix: "nurse" }))
      .accessToken;
    operatorToken = (
      await createContractedOperator(app, prisma, { clinicTenantId: tenant.id, role: UserRole.OPERATOR, emailPrefix: "operator" })
    ).accessToken;
    otherTenantNurseToken = (
      await createLoggedInUser(app, { tenantId: otherTenant.id, role: UserRole.NURSING, emailPrefix: "other-nurse" })
    ).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function createQueueEntry(equipmentId: string, patientFirstName: string): Promise<string> {
    const res = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId, patientFirstName })
      .expect(201);
    return res.body.id;
  }

  async function listOrder(equipmentId: string): Promise<string[]> {
    const res = await http.get(`/queue?equipmentId=${equipmentId}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    return [...res.body].sort((a: { position: number }, b: { position: number }) => a.position - b.position).map((e: { id: string }) => e.id);
  }

  it("renumbers WAITING entries into contiguous positions matching the new order", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-1");
    const a = await createQueueEntry(equipmentId, "Maria");
    const b = await createQueueEntry(equipmentId, "Amanda");
    const c = await createQueueEntry(equipmentId, "Joao");
    expect(await listOrder(equipmentId)).toEqual([a, b, c]);

    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [c, a, b] })
      .expect(204);

    expect(await listOrder(equipmentId)).toEqual([c, a, b]);

    const positions = await prisma.queueEntry.findMany({
      where: { id: { in: [a, b, c] } },
      select: { id: true, position: true },
    });
    const byId = new Map(positions.map((p) => [p.id, p.position]));
    const sorted = [...positions].sort((x, y) => x.position - y.position);
    // Contiguous, ascending -- no gaps introduced by the renumber.
    expect(sorted[1].position - sorted[0].position).toBe(1);
    expect(sorted[2].position - sorted[1].position).toBe(1);
    expect(byId.get(c)).toBeLessThan(byId.get(a)!);
    expect(byId.get(a)).toBeLessThan(byId.get(b)!);
  });

  it("leaves an IN_PROGRESS entry's position untouched and excludes it from the reorderable set", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-2");
    const inProgress = await createQueueEntry(equipmentId, "Started-Patient");
    const waitingOne = await createQueueEntry(equipmentId, "Waiting-One");
    const waitingTwo = await createQueueEntry(equipmentId, "Waiting-Two");

    await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId, queueEntryId: inProgress })
      .expect(201);

    const before = await prisma.queueEntry.findUnique({ where: { id: inProgress }, select: { position: true } });

    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [waitingTwo, waitingOne] })
      .expect(204);

    const after = await prisma.queueEntry.findUnique({ where: { id: inProgress }, select: { position: true } });
    expect(after?.position).toBe(before?.position);

    const waitingOrder = await listOrder(equipmentId);
    expect(waitingOrder.filter((id) => id !== inProgress)).toEqual([waitingTwo, waitingOne]);
  });

  it("rejects an ordering that includes a patient no longer WAITING, and leaves positions unchanged", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-3");
    const started = await createQueueEntry(equipmentId, "Now-In-Progress");
    const waiting = await createQueueEntry(equipmentId, "Still-Waiting");

    await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId, queueEntryId: started })
      .expect(201);

    const before = await prisma.queueEntry.findMany({
      where: { id: { in: [started, waiting] } },
      select: { id: true, position: true },
    });

    const res = await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [started, waiting] })
      .expect(409);
    expect(res.body.code).toBe("CONFLICT");

    const after = await prisma.queueEntry.findMany({
      where: { id: { in: [started, waiting] } },
      select: { id: true, position: true },
    });
    expect(after).toEqual(before);
  });

  it("rejects a stale/mismatched set (missing a currently-WAITING entry)", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-4");
    const a = await createQueueEntry(equipmentId, "A");
    const b = await createQueueEntry(equipmentId, "B");
    // A third patient was added by someone else after this nurse's client last loaded --
    // her drag-drafted order only knows about a/b.
    await createQueueEntry(equipmentId, "C");

    const res = await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [b, a] })
      .expect(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("treats resubmitting the current order as a no-op -- no audit row written", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-5");
    const a = await createQueueEntry(equipmentId, "Noop-A");
    const b = await createQueueEntry(equipmentId, "Noop-B");

    const auditBefore = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const countBefore = auditBefore.body.filter((e: { action: string }) => e.action === "QUEUE_REORDERED").length;

    // Same order the entries are already in -- a genuine no-op.
    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [a, b] })
      .expect(204);

    const auditAfter = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const countAfter = auditAfter.body.filter((e: { action: string }) => e.action === "QUEUE_REORDERED").length;
    expect(countAfter).toBe(countBefore);
  });

  it("audits a real reorder with the equipment id and both orderings, and no patient name", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-6");
    const a = await createQueueEntry(equipmentId, "Audit-Name-A");
    const b = await createQueueEntry(equipmentId, "Audit-Name-B");

    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [b, a] })
      .expect(204);

    const auditRes = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const event = auditRes.body.find(
      (e: { action: string; resourceId: string }) => e.action === "QUEUE_REORDERED" && e.resourceId === equipmentId
    );
    expect(event).toBeTruthy();
    expect(event.details.previousOrder).toEqual([a, b]);
    expect(event.details.newOrder).toEqual([b, a]);
    expect(JSON.stringify(event.details)).not.toContain("Audit-Name");
  });

  it("rejects a cross-tenant nurse's attempt to reorder another tenant's queue", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-7");
    const a = await createQueueEntry(equipmentId, "Cross-A");
    const b = await createQueueEntry(equipmentId, "Cross-B");

    const res = await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${otherTenantNurseToken}`)
      .send({ equipmentId, orderedIds: [b, a] })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    expect(await listOrder(equipmentId)).toEqual([a, b]);
  });

  it("rejects OPERATOR reordering the queue, and audits the denial", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-8");
    const a = await createQueueEntry(equipmentId, "Op-Denied-A");
    const b = await createQueueEntry(equipmentId, "Op-Denied-B");

    const res = await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId, orderedIds: [b, a] })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    expect(await listOrder(equipmentId)).toEqual([a, b]);

    const auditRes = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const denied = auditRes.body.find(
      (e: { action: string; details: { path?: string } }) => e.action === "PERMISSION_DENIED" && e.details.path === "/queue/reorder"
    );
    expect(denied).toBeTruthy();
    expect(denied.details.requiredRoles).toContain("NURSING");
  });

  it("rejects fewer than 2 ids and duplicate ids at the schema level", async () => {
    const equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Reorder-MRI-9");
    const a = await createQueueEntry(equipmentId, "Solo-A");

    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [a] })
      .expect(400);

    const b = await createQueueEntry(equipmentId, "Solo-B");
    await http
      .post("/queue/reorder")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ equipmentId, orderedIds: [a, b, a] })
      .expect(400);
  });
});
