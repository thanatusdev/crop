import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole, toClinicDayString, todayClinicDayString } from "@crop/shared";
import {
  createTestApp,
  createLoggedInUser,
  createContractedOperator,
  createTenant,
  testPrisma,
  equipmentPayload,
  clinicPayload,
} from "./helpers.js";

/**
 * The exam-support chat: the real, persisted clinic<->operator text channel replacing the
 * "no messaging transport exists anywhere in this codebase" gap two prior nursing prototypes
 * both left in place (see docs/architecture.md).
 *
 * Sending moved to REST (`POST /chat/messages`, multipart, optionally carrying a file) --
 * see `SendExamMessageRequestSchema`'s own docstring for why. Reading is REST too (unchanged).
 * The socket's only remaining role is `JOIN_EQUIPMENT_CHAT`, joined to receive the live
 * `EXAM_MESSAGE_CREATED` broadcast a successful send produces -- this is also what makes
 * nursing (which never joins a *session*) able to participate in this chat at all, unlike the
 * old design this test file used to exercise.
 */
describe("Exam-support chat, quick-reply shortcuts, and attachments", () => {
  let app: INestApplication;
  let baseUrl: string;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let clinicId: string;
  let adminToken: string;
  let operatorToken: string;
  let nursingToken: string;
  let equipmentId: string;
  let sessionId: string;
  const today = todayClinicDayString();

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0); // real socket, needed for socket.io-client -- see websocket-gateway.e2e.spec.ts
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    http = request(baseUrl);
    prisma = testPrisma();

    const clinic = await createTenant(prisma, `ExamChat-${crypto.randomUUID()}`);
    clinicId = clinic.id;
    const admin = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.CLINIC_ADMIN });
    adminToken = admin.accessToken;
    const nursing = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.NURSING, emailPrefix: "chat-nursing" });
    nursingToken = nursing.accessToken;
    const operator = await createContractedOperator(app, prisma, { clinicTenantId: clinicId, role: UserRole.OPERATOR, emailPrefix: "chat-operator" });
    operatorToken = operator.accessToken;

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Chat-Test-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    equipmentId = equipmentRes.body.id;
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });

    const sessionRes = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId }).expect(201);
    sessionId = sessionRes.body.id;
  });

  afterAll(async () => {
    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`);
    await prisma.$disconnect();
    await app.close();
  });

  function connectSocket(token: string): Socket {
    return io(baseUrl, { path: "/rt", transports: ["websocket"], auth: { token }, autoConnect: false });
  }

  async function connect(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", reject);
      socket.connect();
    });
  }

  async function joinEquipmentChatAndWait(socket: Socket): Promise<void> {
    socket.emit(RT_EVENTS.JOIN_EQUIPMENT_CHAT, { equipmentId });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  it("sends a message over REST, broadcasts it to every socket joined to the room's chat, and persists it with the author's name resolved", async () => {
    const listener = connectSocket(adminToken);
    await connect(listener);
    await joinEquipmentChatAndWait(listener);

    const received = new Promise<{ body: string; authorName: string | null; equipmentId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No EXAM_MESSAGE_CREATED received")), 3000);
      listener.on(RT_EVENTS.EXAM_MESSAGE_CREATED, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    const sendRes = await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${operatorToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "Scanner calibrado, pronto para iniciar.")
      .expect(201);
    expect(sendRes.body.body).toBe("Scanner calibrado, pronto para iniciar.");
    expect(sendRes.body.authorName).toBeTruthy();

    const payload = await received;
    expect(payload.body).toBe("Scanner calibrado, pronto para iniciar.");
    expect(payload.equipmentId).toBe(equipmentId);
    // Resolved at broadcast time, never a raw id -- see ExamMessageDto's own docstring.
    expect(payload.authorName).toBeTruthy();

    const list = await http.get(`/chat/messages?equipmentId=${equipmentId}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(list.body.some((m: { body: string }) => m.body === "Scanner calibrado, pronto para iniciar.")).toBe(true);

    const auditRes = await http.get("/audit?limit=500").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const row = auditRes.body.find((e: { action: string }) => e.action === "EXAM_MESSAGE_SENT");
    expect(row).toBeTruthy();
    // Ids and attachment metadata only, never the message body -- see
    // AuditAction.EXAM_MESSAGE_SENT's own docstring.
    expect(JSON.stringify(row.details)).not.toContain("calibrado");
    expect(row.details.equipmentId).toBe(equipmentId);
    expect(row.details.hasAttachment).toBe(false);

    listener.disconnect();
  });

  it("lets nursing -- which never joins a session -- send and receive this chat", async () => {
    const nurseSocket = connectSocket(nursingToken);
    await connect(nurseSocket);
    await joinEquipmentChatAndWait(nurseSocket);

    const received = new Promise<{ body: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Nursing socket never received EXAM_MESSAGE_CREATED")), 3000);
      nurseSocket.on(RT_EVENTS.EXAM_MESSAGE_CREATED, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    // The operator sends; nursing, joined to the room's chat but never to any session,
    // still receives the broadcast.
    await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${operatorToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "Paciente com alergia a iodo confirmada.")
      .expect(201);
    expect((await received).body).toBe("Paciente com alergia a iodo confirmada.");

    // Nursing sends its own message too, over the exact same REST endpoint.
    const nurseSend = await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${nursingToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "Recebido, aguardando pré-medicação.")
      .expect(201);
    expect(nurseSend.body.body).toBe("Recebido, aguardando pré-medicação.");

    nurseSocket.disconnect();
  });

  it("rejects a send with neither text nor an attachment", async () => {
    await http.post("/chat/messages").set("Authorization", `Bearer ${operatorToken}`).field("equipmentId", equipmentId).field("body", "").expect(400);
  });

  it("uploads a small PNG attachment, broadcasts and lists it without a body, and lets an authorized reader download the exact bytes back", async () => {
    // A 1x1 transparent PNG, small enough to inline as a fixture rather than reading a file
    // from disk for one pixel of data.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );

    const sendRes = await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${operatorToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "")
      .attach("file", png, { filename: "wristband.png", contentType: "image/png" })
      .expect(201);
    expect(sendRes.body.body).toBe("");
    expect(sendRes.body.attachment).toMatchObject({ filename: "wristband.png", mimeType: "image/png", sizeBytes: png.length });
    const messageId = sendRes.body.id;

    const download = await http.get(`/chat/messages/${messageId}/attachment`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(Buffer.compare(download.body, png)).toBe(0);

    // A different clinic's admin, with no relationship to this room at all, is refused --
    // same tenancy check every other single-resource read in this suite exercises.
    const otherClinic = await createTenant(prisma, `ExamChatAttachmentOther-${crypto.randomUUID()}`);
    const otherAdmin = await createLoggedInUser(app, { tenantId: otherClinic.id, role: UserRole.CLINIC_ADMIN, emailPrefix: "attachment-other-admin" });
    await http.get(`/chat/messages/${messageId}/attachment`).set("Authorization", `Bearer ${otherAdmin.accessToken}`).expect(403);
  });

  it("rejects an attachment of a disallowed mime type", async () => {
    await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${operatorToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "")
      .attach("file", Buffer.from("#!/bin/sh\necho hi\n"), { filename: "script.sh", contentType: "application/x-sh" })
      .expect(400);
  });

  it("scopes the transcript to the requested clinical day", async () => {
    const yesterdayRes = await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${operatorToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "mensagem de ontem")
      .expect(201);
    // Backdated directly -- there is no API to send a message on a day other than "now",
    // by design (a real send always happens at the instant it happens); this fixture only
    // needs a row that *reads* as yesterday's.
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await prisma.examMessage.update({ where: { id: yesterdayRes.body.id }, data: { createdAt: yesterday } });

    const todayList = await http.get(`/chat/messages?equipmentId=${equipmentId}&date=${today}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(todayList.body.some((m: { body: string }) => m.body === "mensagem de ontem")).toBe(false);

    const yesterdayDay = toClinicDayString(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const yesterdayList = await http
      .get(`/chat/messages?equipmentId=${equipmentId}&date=${yesterdayDay}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(yesterdayList.body.some((m: { body: string }) => m.body === "mensagem de ontem")).toBe(true);
  });

  it("refuses to list or send to another tenant's chat, and refuses a contracted operator reaching a room outside their agreement scope", async () => {
    const otherClinic = await createTenant(prisma, `ExamChatOther-${crypto.randomUUID()}`);
    const otherAdmin = await createLoggedInUser(app, { tenantId: otherClinic.id, role: UserRole.CLINIC_ADMIN, emailPrefix: "chat-other-admin" });
    const crossTenant = await http
      .get(`/chat/messages?equipmentId=${equipmentId}`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
      .expect(403);
    expect(crossTenant.body.code).toBe("FORBIDDEN");

    // A second, separate room this clinic owns but never granted to any operator -- reusing
    // the same operator's agreement (unit-scoped to the first equipment's unit only, via
    // createContractedOperator's own default grant) means this second room is out of scope.
    const secondUnit = (
      await http
        .post("/units")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: `Ungranted-${crypto.randomUUID().slice(0, 8)}`,
          establishmentType: "LABORATORY",
          technicalManagerId: (await http.get("/auth/me").set("Authorization", `Bearer ${adminToken}`).expect(200)).body.id,
          declaredModalities: ["CT"],
          zipCode: "01310-100",
          street: "Rua Teste",
          number: "1",
          district: "Centro",
          city: "São Paulo",
          state: "SP",
        })
        .expect(201)
    ).body;
    const secondEquipment = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "Chat-Ungranted-CT", unitId: secondUnit.id }))
      .expect(201);

    const outOfScope = await http
      .get(`/chat/messages?equipmentId=${secondEquipment.body.id}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .expect(403);
    expect(outOfScope.body.code).toBe("FORBIDDEN");

    const sendOutOfScope = await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${operatorToken}`)
      .field("equipmentId", secondEquipment.body.id)
      .field("body", "should never be stored")
      .expect(403);
    expect(sendOutOfScope.body.code).toBe("FORBIDDEN");

    // The same out-of-scope operator's socket is refused when it tries to join that room's
    // chat -- CanAccessEquipmentChatHandler re-checks the identical agreement scope, so a
    // socket can never sit in a room it could not otherwise read.
    const rogue = connectSocket(operatorToken);
    await connect(rogue);
    const refusal = new Promise<{ message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No ERROR received for out-of-scope JOIN_EQUIPMENT_CHAT")), 3000);
      rogue.on(RT_EVENTS.ERROR, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
    rogue.emit(RT_EVENTS.JOIN_EQUIPMENT_CHAT, { equipmentId: secondEquipment.body.id });
    expect((await refusal).message).toBeTruthy();
    rogue.disconnect();
  });

  it("refuses LOCAL_IT, which has no legitimate reason to read patient-adjacent chat", async () => {
    const localIt = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.LOCAL_IT, emailPrefix: "chat-local-it" });
    await http.get(`/chat/messages?equipmentId=${equipmentId}`).set("Authorization", `Bearer ${localIt.accessToken}`).expect(403);
    await http.get("/chat/shortcuts").set("Authorization", `Bearer ${localIt.accessToken}`).expect(403);
    await http
      .post("/chat/messages")
      .set("Authorization", `Bearer ${localIt.accessToken}`)
      .field("equipmentId", equipmentId)
      .field("body", "should never be stored")
      .expect(403);
  });

  it("creates a shortcut, uppercasing its code, rejects a duplicate, and audits the creation", async () => {
    const created = await http
      .post("/chat/shortcuts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "cont", label: "Contraste", body: "Contraste administrado." })
      .expect(201);
    expect(created.body.code).toBe("CONT");

    const duplicate = await http
      .post("/chat/shortcuts")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "CONT", label: "Outro", body: "Outro corpo." })
      .expect(409);
    expect(duplicate.body.code).toBe("CONFLICT");

    const auditRes = await http.get("/audit?limit=500").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const row = auditRes.body.find(
      (e: { action: string; resourceId: string }) => e.action === "MESSAGE_SHORTCUT_CREATED" && e.resourceId === created.body.id
    );
    expect(row).toBeTruthy();
    expect(row.details.code).toBe("CONT");
  });

  it("scopes shortcuts per clinic -- one clinic never sees another's", async () => {
    const otherClinic = await createTenant(prisma, `ExamChatShortcutsOther-${crypto.randomUUID()}`);
    const otherAdmin = await createLoggedInUser(app, {
      tenantId: otherClinic.id,
      role: UserRole.CLINIC_ADMIN,
      emailPrefix: "shortcuts-other-admin",
    });
    await http
      .post("/chat/shortcuts")
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`)
      .send({ code: "ONLYOTHER", label: "Só na outra", body: "..." })
      .expect(201);

    const mine = await http.get("/chat/shortcuts").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(mine.body.some((s: { code: string }) => s.code === "ONLYOTHER")).toBe(false);

    const theirs = await http.get("/chat/shortcuts").set("Authorization", `Bearer ${otherAdmin.accessToken}`).expect(200);
    expect(theirs.body.some((s: { code: string }) => s.code === "ONLYOTHER")).toBe(true);
  });

  it("seeds the six default shortcuts into a brand-new clinic tenant, reacting to TenantCreatedEvent", async () => {
    const platformTenant = await createTenant(prisma, `Platform-${crypto.randomUUID()}`, "PLATFORM");
    const platformAdminToken = (await createLoggedInUser(app, { tenantId: platformTenant.id, role: UserRole.PLATFORM_ADMIN })).accessToken;

    const created = await http.post("/tenants").set("Authorization", `Bearer ${platformAdminToken}`).send(clinicPayload()).expect(201);

    // Best-effort wait: TenantCreatedEvent's own handler runs asynchronously off the
    // CommandBus's publish, not inline with the 201 response.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const newClinicAdmin = await createLoggedInUser(app, {
      tenantId: created.body.id,
      role: UserRole.CLINIC_ADMIN,
      emailPrefix: "fresh-clinic-admin",
    });
    const shortcuts = await http.get("/chat/shortcuts").set("Authorization", `Bearer ${newClinicAdmin.accessToken}`).expect(200);
    const codes = shortcuts.body.map((s: { code: string }) => s.code).sort();
    expect(codes).toEqual(["CONT", "INT", "PL", "PSM", "TB", "TL"]);
  });
});
