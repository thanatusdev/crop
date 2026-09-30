import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * RT_EVENTS.QUEUE_UPDATED and RT_EVENTS.EQUIPMENT_STATUS_CHANGED existed as constants from
 * the start but were never emitted anywhere or listened for anywhere -- found via a full
 * backend<->frontend coverage audit. Without them, two simultaneous dashboards only ever saw
 * each other's queue/equipment changes after a manual reload. Fixed via @nestjs/cqrs's
 * EventBus (not a direct call from QueueModule/EquipmentModule into SessionsGateway, which
 * would be a module import cycle -- see QueueUpdatedEvent's own docstring).
 *
 * Needs a real listening HTTP server for the same reason websocket-gateway.e2e.spec.ts does
 * -- a real Socket.io client performs a real WebSocket upgrade over a real TCP connection.
 */
describe("Real-time push: queue and equipment status", () => {
  let app: INestApplication;
  let baseUrl: string;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantAId: string;
  let tenantAAdminToken: string;
  let tenantBAdminToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    http = request(baseUrl);
    prisma = testPrisma();

    tenantAId = (await createTenant(prisma, `Realtime-A-${crypto.randomUUID()}`)).id;
    tenantAAdminToken = (await createLoggedInUser(app, { tenantId: tenantAId, role: UserRole.CLINIC_ADMIN })).accessToken;
    const tenantBId = (await createTenant(prisma, `Realtime-B-${crypto.randomUUID()}`)).id;
    tenantBAdminToken = (await createLoggedInUser(app, { tenantId: tenantBId, role: UserRole.CLINIC_ADMIN, emailPrefix: "realtime-b-admin" }))
      .accessToken;

    const eqRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send(equipmentPayload({ name: "Realtime-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    equipmentId = eqRes.body.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  function connect(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket: Socket = io(baseUrl, { path: "/rt", transports: ["websocket"], auth: { token }, autoConnect: false });
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", reject);
      socket.connect();
    });
  }

  it("pushes QUEUE_UPDATED to the same tenant's connected clients when a patient is added, but never to a different tenant's", async () => {
    const sameTenantSocket = await connect(tenantAAdminToken);
    const otherTenantSocket = await connect(tenantBAdminToken);

    const receivedBySameTenant = new Promise<{ equipmentId: string }>((resolve) => {
      sameTenantSocket.on(RT_EVENTS.QUEUE_UPDATED, resolve);
    });
    let otherTenantReceived = false;
    otherTenantSocket.on(RT_EVENTS.QUEUE_UPDATED, () => {
      otherTenantReceived = true;
    });

    await http.post("/queue").set("Authorization", `Bearer ${tenantAAdminToken}`).send({ equipmentId, patientFirstName: "Realtime-Patient" }).expect(201);

    const payload = await receivedBySameTenant;
    expect(payload.equipmentId).toBe(equipmentId);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(otherTenantReceived).toBe(false);

    sameTenantSocket.disconnect();
    otherTenantSocket.disconnect();
  });

  it("pushes EQUIPMENT_STATUS_CHANGED when maintenance mode is entered and cleared", async () => {
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });
    const socket = await connect(tenantAAdminToken);

    const enteredMaintenance = new Promise<{ equipmentId: string; status: string }>((resolve) => {
      socket.on(RT_EVENTS.EQUIPMENT_STATUS_CHANGED, resolve);
    });
    await http.post(`/equipment/${equipmentId}/maintenance`).set("Authorization", `Bearer ${tenantAAdminToken}`).expect(204);
    const enteredPayload = await enteredMaintenance;
    expect(enteredPayload.equipmentId).toBe(equipmentId);
    expect(enteredPayload.status).toBe("MAINTENANCE");

    const clearedMaintenance = new Promise<{ equipmentId: string; status: string }>((resolve) => {
      socket.on(RT_EVENTS.EQUIPMENT_STATUS_CHANGED, resolve);
    });
    await http.post(`/equipment/${equipmentId}/maintenance/clear`).set("Authorization", `Bearer ${tenantAAdminToken}`).expect(204);
    const clearedPayload = await clearedMaintenance;
    expect(clearedPayload.status).toBe("OFFLINE");

    socket.disconnect();
  });

  it("pushes PATIENT_PREPARATION_UPDATED when the nurse positions a patient", async () => {
    const nurseToken = (
      await createLoggedInUser(app, { tenantId: tenantAId, role: UserRole.NURSING, emailPrefix: "realtime-nurse" })
    ).accessToken;
    const queueRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({ equipmentId, patientFirstName: "Realtime-Prep-Patient" })
      .expect(201);

    const socket = await connect(tenantAAdminToken);
    const received = new Promise<{ queueEntryId: string; preparationStatus: string }>((resolve) => {
      socket.on(RT_EVENTS.PATIENT_PREPARATION_UPDATED, resolve);
    });

    await http
      .post(`/queue/${queueRes.body.id}/preparation`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "POSITIONED" })
      .expect(204);

    const payload = await received;
    expect(payload.queueEntryId).toBe(queueRes.body.id);
    expect(payload.preparationStatus).toBe("POSITIONED");

    socket.disconnect();
  });

  // Bug fix: StartSessionHandler/EndSessionHandler/AbortIdleSessionHandler each wrote the
  // queue entry's status directly via the repository, bypassing UpdateQueueStatusHandler --
  // the only place QueueUpdatedEvent was ever published from -- so a session's lifecycle
  // never told any connected dashboard its queue entry had moved to IN_PROGRESS/DONE/
  // CANCELLED. Fixed by publishing the same event from all three handlers too.
  it("pushes QUEUE_UPDATED when a session starts against a queue entry, and again when it ends", async () => {
    const operatorToken = (
      await createContractedOperator(app, prisma, { clinicTenantId: tenantAId, role: UserRole.OPERATOR, emailPrefix: "realtime-operator" })
    ).accessToken;
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });
    const queueRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({ equipmentId, patientFirstName: "Realtime-Lifecycle-Patient" })
      .expect(201);

    const socket = await connect(tenantAAdminToken);
    const receivedOnStart = new Promise<{ equipmentId: string }>((resolve) => {
      socket.once(RT_EVENTS.QUEUE_UPDATED, resolve);
    });

    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId, queueEntryId: queueRes.body.id })
      .expect(201);
    await receivedOnStart;

    const receivedOnEnd = new Promise<{ equipmentId: string }>((resolve) => {
      socket.once(RT_EVENTS.QUEUE_UPDATED, resolve);
    });
    await http.post(`/sessions/${sessionRes.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
    const payload = await receivedOnEnd;
    expect(payload.equipmentId).toBe(equipmentId);

    socket.disconnect();
  });
});
