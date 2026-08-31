import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * Takeover had zero test coverage before this phase despite being one of the platform's
 * three headline features (README's "mandatory 2FA, enforced supervisor takeover, and a
 * hash-chained append-only audit trail"). Writing these is what found the two real bugs
 * documented in docs/architecture.md: `ExecuteTakeoverHandler` had no tenant-isolation
 * check at all (any supervisor/admin in ANY tenant could take over ANY other tenant's
 * active session by sessionId alone), and `setController` was an unconditional write with
 * no protection against two near-simultaneous takeover attempts.
 */
describe("Supervisor takeover", () => {
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
    await app.listen(0); // real socket, needed for socket.io-client -- see websocket-gateway.e2e.spec.ts
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    http = request(baseUrl);
    prisma = testPrisma();

    const alpha = await createTenant(prisma, `TakeoverAlpha-${crypto.randomUUID()}`);
    const beta = await createTenant(prisma, `TakeoverBeta-${crypto.randomUUID()}`);
    alphaTenantId = alpha.id;
    betaTenantId = beta.id;

    const admin = await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.CLINIC_ADMIN });
    alphaAdminToken = admin.accessToken;
    const operator = await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.OPERATOR, emailPrefix: "operator" });
    alphaOperatorToken = operator.accessToken;
    alphaOperatorId = operator.userId;

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ name: "Takeover-Test-MRI", pikvmHost: "https://192.0.2.1", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
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

  async function endSession(sessionId: string, token: string): Promise<void> {
    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${token}`);
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

  it("lets a supervisor take over an operator's active session, and audits request + grant", async () => {
    const sessionId = await startSession();
    const supervisor = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "sup-happy" });

    const socket = connectSocket(supervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    // A successful takeover calls releaseAllInput -> PiKvmHidClient.releaseAll() -> a real
    // REST round trip to /api/hid/reset against this fixture's deliberately-unreachable
    // 192.0.2.1 host, which only resolves once PiKvmRestClient's 5s AbortSignal.timeout
    // fires (see docs/architecture.md's "every network call to hardware needs a timeout").
    await new Promise((r) => setTimeout(r, 5500));
    socket.disconnect();

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(supervisor.userId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions).toContain("TAKEOVER_REQUESTED");
    expect(actions).toContain("TAKEOVER_GRANTED");

    await endSession(sessionId, alphaOperatorToken);
  });

  it("rejects a cross-tenant takeover attempt, and still audits the attempt under the victim's own tenant", async () => {
    const sessionId = await startSession();
    // A real SUPERVISOR, correctly privileged -- just in the wrong tenant entirely.
    const betaSupervisor = await createLoggedInUser(app, {
      tenantId: betaTenantId,
      role: UserRole.SUPERVISOR,
      emailPrefix: "cross-tenant-attacker",
    });

    const socket = connectSocket(betaSupervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 300));
    socket.disconnect();

    // The attack must not have worked: the operator is still in control.
    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(alphaOperatorId);

    // And alpha's own auditors can see the attempt happened -- not silently attributed to
    // beta's tenant, where alpha would never be able to find it.
    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions).toContain("TAKEOVER_REQUESTED");
    expect(actions).not.toContain("TAKEOVER_GRANTED");

    await endSession(sessionId, alphaOperatorToken);
  });

  it("rejects a takeover attempt by an OPERATOR (not supervisor/admin), audited but not granted", async () => {
    const sessionId = await startSession();
    const otherOperator = await createLoggedInUser(app, {
      tenantId: alphaTenantId,
      role: UserRole.OPERATOR,
      emailPrefix: "wrong-role",
    });

    const socket = connectSocket(otherOperator.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 300));
    socket.disconnect();

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    expect(sessionRes.body.controllerUserId).toBe(alphaOperatorId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    expect(actions).toContain("TAKEOVER_REQUESTED");
    expect(actions).not.toContain("TAKEOVER_GRANTED");

    await endSession(sessionId, alphaOperatorToken);
  });

  it("rejects a supervisor taking over a session they already control", async () => {
    const sessionId = await startSession();
    const supervisor = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "self-takeover" });

    const socket = connectSocket(supervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    // First attempt succeeds -- same 5s device-timeout wait as the happy-path test above.
    await new Promise((r) => setTimeout(r, 5500));

    // Second attempt, same supervisor, now already in control -- fails at
    // `assertCanBeTakenOverBy` before ever reaching the device, so it's fast.
    socket.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    await new Promise((r) => setTimeout(r, 300));
    socket.disconnect();

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    // Two attempts, but only the first could have actually changed anything.
    expect(actions.filter((a) => a === "TAKEOVER_REQUESTED")).toHaveLength(2);
    expect(actions.filter((a) => a === "TAKEOVER_GRANTED")).toHaveLength(1);

    await endSession(sessionId, alphaOperatorToken);
  });

  it("resolves two near-simultaneous takeover attempts to exactly one winner, never both", async () => {
    const sessionId = await startSession();
    const supervisorA = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "race-a" });
    const supervisorB = await createLoggedInUser(app, { tenantId: alphaTenantId, role: UserRole.SUPERVISOR, emailPrefix: "race-b" });

    const socketA = connectSocket(supervisorA.accessToken);
    const socketB = connectSocket(supervisorB.accessToken);
    await Promise.all([connect(socketA), connect(socketB)]);

    // Fired back-to-back, no await between them -- the closest two independent socket.io
    // clients can get to "simultaneous" without reaching into the process to force it.
    socketA.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    socketB.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
    // Both attempts pass every check and reach releaseAllInput -- concurrently, so this is
    // still one ~5s wait, not two back-to-back.
    await new Promise((r) => setTimeout(r, 5500));
    socketA.disconnect();
    socketB.disconnect();

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${alphaAdminToken}`).expect(200);
    // The critical invariant: the database ends up with exactly one of the two as
    // controller -- never neither (a lost update leaving the original operator stuck
    // as an incorrect "controller" on record) and never some third, impossible value.
    expect([supervisorA.userId, supervisorB.userId]).toContain(sessionRes.body.controllerUserId);

    const actions = await auditActionsFor(alphaAdminToken, sessionId);
    // Whether or not the two requests actually raced at the database level (timing-
    // dependent, not guaranteed on every run), the outcome must always be exactly one
    // grant -- never zero (both lost, impossible if the operator wasn't already the
    // target) and never two (both "won", the exact inconsistency the CAS prevents).
    expect(actions.filter((a) => a === "TAKEOVER_GRANTED")).toHaveLength(1);
    expect(actions.filter((a) => a === "TAKEOVER_REQUESTED")).toHaveLength(2);

    await endSession(sessionId, alphaOperatorToken);
  });

  it("the underlying compare-and-swap primitive lets exactly one of two concurrent conditional updates win", async () => {
    // A direct, deterministic proof of the mechanism itself (real timing over a real
    // WebSocket in the test above can't guarantee true interleaving on every run) --
    // two concurrent `updateMany`s racing against the *same* expected prior value,
    // exactly like PrismaSessionRepository.setController does.
    const sessionId = await startSession();
    const before = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

    const [resultA, resultB] = await Promise.all([
      prisma.session.updateMany({
        where: { id: sessionId, controllerUserId: before.controllerUserId },
        data: { controllerUserId: "11111111-1111-1111-1111-111111111111" },
      }),
      prisma.session.updateMany({
        where: { id: sessionId, controllerUserId: before.controllerUserId },
        data: { controllerUserId: "22222222-2222-2222-2222-222222222222" },
      }),
    ]);

    expect(resultA.count + resultB.count).toBe(1);

    await endSession(sessionId, alphaOperatorToken);
  });
});
