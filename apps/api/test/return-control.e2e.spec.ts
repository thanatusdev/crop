import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * Split into its own file, not a second `describe` block in takeover.e2e.spec.ts: each e2e
 * spec file boots its own full Nest application (see vitest.config.ts's comment), and a
 * second `createTestApp()` + `app.listen(0)` inside the *same* file/process crashed the
 * whole worker with a raw V8 abort during `NestFactory.create()` -- almost certainly a
 * global singleton (Prisma's engine process, or prom-client's default metrics registry, both
 * of which this app never expected to initialize twice in one process) rather than anything
 * specific to this feature. Not investigated further since the one-app-per-file convention
 * every other spec already follows sidesteps it entirely.
 */
describe("Return control to operator", () => {
  let app: INestApplication;
  let baseUrl: string;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let alphaTenantId: string;
  let betaTenantId: string;
  let alphaAdminToken: string;
  let alphaOperatorToken: string;
  let alphaOperatorId: string;
  let alphaEquipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    http = request(baseUrl);
    prisma = testPrisma();

    const alpha = await createTenant(prisma, `ReturnControlAlpha-${crypto.randomUUID()}`);
    const beta = await createTenant(prisma, `ReturnControlBeta-${crypto.randomUUID()}`);
    alphaTenantId = alpha.id;
    betaTenantId = beta.id;

    const admin = await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.CLINIC_ADMIN });
    alphaAdminToken = admin.accessToken;
    const operator = await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.OPERATOR, emailPrefix: "rc-operator" });
    alphaOperatorToken = operator.accessToken;
    alphaOperatorId = operator.userId;

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ name: "ReturnControl-Test-MRI", pikvmHost: "https://192.0.2.1", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(201);
    alphaEquipmentId = equipmentRes.body.id;
    await prisma.equipment.update({ where: { id: alphaEquipmentId }, data: { status: "ONLINE" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function startSession(): Promise<string> {
    const res = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${alphaOperatorToken}`)
      .send({ equipmentId: alphaEquipmentId })
      .expect(201);
    return res.body.id;
  }

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

  async function auditActionsFor(token: string, sessionId: string): Promise<string[]> {
    const res = await http.get(`/audit?sessionId=${sessionId}&limit=200`).set("Authorization", `Bearer ${token}`).expect(200);
    return res.body.map((e: { action: string }) => e.action);
  }

  async function takeOver(sessionId: string, token: string): Promise<void> {
    const socket = connectSocket(token);
    await connect(socket);
    socket.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 5500)); // releaseAllInput's device timeout, see takeover.e2e.spec.ts
    socket.disconnect();
  }

  it("lets a supervisor hand control back to the operator after taking over", async () => {
    const sessionId = await startSession();
    const supervisor = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "rc-happy" });

    await takeOver(sessionId, supervisor.accessToken);
    let sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(supervisor.userId);

    const socket = connectSocket(supervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 5500));
    socket.disconnect();

    sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(alphaOperatorId);
    // The supervisor stays on record even after handing control back -- see the handler's
    // docstring on why `supervisorId` is passed through unchanged, not cleared.
    expect(sessionRes.body.supervisorId).toBe(supervisor.userId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions).toContain("RETURN_CONTROL_REQUESTED");
    expect(actions).toContain("RETURN_CONTROL_GRANTED");

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${alphaOperatorToken}`);
  });

  it("lets a different eligible supervisor/admin return control, not only the one who took it", async () => {
    const sessionId = await startSession();
    const takingSupervisor = await createLoggedInUser(app, {
      tenantId: alphaTenantId,
      role: UserRole.SUPERVISOR,
      emailPrefix: "rc-other-taker",
    });

    await takeOver(sessionId, takingSupervisor.accessToken);

    // A different admin, uninvolved in the takeover, decides it's safe to hand back.
    const socket = connectSocket(alphaAdminToken);
    await connect(socket);
    socket.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 5500));
    socket.disconnect();

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(alphaOperatorId);

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${alphaOperatorToken}`);
  });

  it("rejects returning control when the operator already has it", async () => {
    const sessionId = await startSession();
    const supervisor = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "rc-noop" });

    const socket = connectSocket(supervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 300)); // fails at assertControlCanBeReturnedToOperator, before the device call
    socket.disconnect();

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(alphaOperatorId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions).toContain("RETURN_CONTROL_REQUESTED");
    expect(actions).not.toContain("RETURN_CONTROL_GRANTED");

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${alphaOperatorToken}`);
  });

  it("rejects a cross-tenant return-control attempt, audited under the victim's own tenant", async () => {
    const sessionId = await startSession();
    const supervisor = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "rc-tenant-taker" });
    await takeOver(sessionId, supervisor.accessToken);

    const betaSupervisor = await createLoggedInUser(app, {
      tenantId: betaTenantId,
      role: UserRole.SUPERVISOR,
      emailPrefix: "rc-cross-tenant",
    });

    const socket = connectSocket(betaSupervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 300)); // fails at the tenant check, before the device call
    socket.disconnect();

    // Control must still be with the supervisor who legitimately took over -- unaffected by
    // beta's attempt.
    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(supervisor.userId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions.filter((a) => a === "RETURN_CONTROL_REQUESTED")).toHaveLength(1);
    expect(actions).not.toContain("RETURN_CONTROL_GRANTED");

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${alphaOperatorToken}`);
  });

  it("rejects an OPERATOR trying to reclaim their own session unilaterally", async () => {
    const sessionId = await startSession();
    const supervisor = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "rc-role-taker" });
    await takeOver(sessionId, supervisor.accessToken);

    const socket = connectSocket(alphaOperatorToken);
    await connect(socket);
    socket.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 300)); // fails at the role check, before the device call
    socket.disconnect();

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(supervisor.userId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions).not.toContain("RETURN_CONTROL_GRANTED");

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${alphaOperatorToken}`);
  });
});
