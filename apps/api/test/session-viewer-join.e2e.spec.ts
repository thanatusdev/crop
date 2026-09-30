import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * Regression test for a real bug found and reported by hand, not by an earlier e2e test: a
 * supervisor who opened an operator's active session to *look* (e.g. via DashboardPage's
 * "Rejoin session", shown for any active session regardless of viewer -- not only via
 * "Take over") never actually joined the session's room. `SessionsGateway.onJoinSession`
 * used to require `session.isParticipant()`, which is only ever true for the operator or a
 * supervisor who has *already* taken over -- a supervisor merely viewing is neither. Their
 * socket silently never joined `room(sessionId)` (only a `RT_EVENTS.ERROR` was emitted,
 * which the frontend never listened for), so once the operator ended the session from their
 * own side, the viewing supervisor's `SESSION_ENDED` handler never fired: no redirect, and
 * their own "End session" button also failed (`EndSessionHandler` correctly requires
 * `isParticipant` too) -- stuck on the page indefinitely. See `docs/architecture.md` and
 * `SessionsGateway`'s `VIEW_ALLOWED_ROLES` for the fix.
 */
describe("A supervisor who only views a session (never takes over) is not stuck when it ends", () => {
  let app: INestApplication;
  let baseUrl: string;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let tenantId: string;
  let adminToken: string;
  let operatorToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0); // real socket needed for a real JOIN_SESSION/SESSION_ENDED round trip
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    http = request(baseUrl);
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `ViewerJoin-${crypto.randomUUID()}`);
    tenantId = tenant.id;
    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN });
    adminToken = admin.accessToken;
    const operator = await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATOR });
    operatorToken = operator.accessToken;

    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "ViewerJoin-Test-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    equipmentId = equipmentRes.body.id;
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function startSession(): Promise<string> {
    const res = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId }).expect(201);
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

  it("lets a supervisor who never took over join the room, and delivers SESSION_ENDED to them once the operator ends it", async () => {
    const sessionId = await startSession();
    const supervisor = await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATIONAL_SUPERVISOR, emailPrefix: "viewer-happy" });

    const socket = connectSocket(supervisor.accessToken);
    await connect(socket);

    const gatewayError: unknown = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 500);
      socket.on(RT_EVENTS.ERROR, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      socket.emit(RT_EVENTS.JOIN_SESSION, { sessionId });
    });
    // The exact regression: this used to always be the "Not a participant" ERROR payload.
    expect(gatewayError).toBeNull();

    const sessionEnded = new Promise<{ sessionId: string }>((resolve, reject) => {
      // Generous: `POST /sessions/:id/end` itself blocks for ~5s awaiting `PiKvmGatewayPort
      // .release()`'s device round trip against this suite's standard unreachable fixture
      // host (same as cross-tenant-pikvm-isolation.e2e.spec.ts) *before* the controller even
      // reaches `broadcastSessionEnded` -- a 3s timeout here would (and did, while writing
      // this test) expire before the broadcast could ever arrive, independent of whether the
      // fix itself works.
      const timeout = setTimeout(() => reject(new Error("SESSION_ENDED never reached the viewing supervisor")), 8000);
      socket.on(RT_EVENTS.SESSION_ENDED, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);

    await expect(sessionEnded).resolves.toEqual({ sessionId });
    socket.disconnect();
  });

  it("still never lets a mere viewer actually send input, even though their socket is now in the room", async () => {
    const sessionId = await startSession();
    const supervisor = await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATIONAL_SUPERVISOR, emailPrefix: "viewer-noinput" });

    const socket = connectSocket(supervisor.accessToken);
    await connect(socket);
    socket.emit(RT_EVENTS.JOIN_SESSION, { sessionId });
    await new Promise((r) => setTimeout(r, 200));

    // Widening the join gate must never widen who can actually act -- onHidInput/onPrintText
    // gate on holding control, checked independently of room membership.
    socket.emit(RT_EVENTS.HID_INPUT, { type: "mouse_move", x: 0, y: 0, ts: performance.now() });
    await new Promise((r) => setTimeout(r, 200));

    const sessionRes = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const operatorId = sessionRes.body.operatorId;
    expect(sessionRes.body.controllerUserId).toBe(operatorId); // unchanged -- the operator, never the viewing supervisor

    socket.disconnect();
    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`);
  });

  it("still rejects JOIN_SESSION from an unrelated OPERATOR in the same tenant (not this session's own, and not a takeover-eligible role)", async () => {
    const sessionId = await startSession();
    const otherOperator = await createContractedOperator(app, prisma, { clinicTenantId: tenantId, role: UserRole.OPERATOR, emailPrefix: "viewer-other-operator" });

    const socket = connectSocket(otherOperator.accessToken);
    await connect(socket);

    const gatewayError = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 500);
      socket.on(RT_EVENTS.ERROR, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      socket.emit(RT_EVENTS.JOIN_SESSION, { sessionId });
    });
    expect(gatewayError).toEqual({ message: "Not a participant of this session" });

    socket.disconnect();
    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`);
  });
});
