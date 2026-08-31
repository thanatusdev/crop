import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * The audit trail is documented (docs/architecture.md) as two-tier: critical events
 * (login, takeover, print, etc.) are written synchronously and are queryable the instant the
 * triggering request completes; routine HID input is buffered in Redis and only lands in
 * Postgres, batched as one AuditAction.INPUT_BATCH row per session, when
 * FlushAuditBufferHandler's cron next runs (AUDIT_FLUSH_INTERVAL_MS, default 5000ms -- see
 * that class and audit-flush.scheduler.ts).
 *
 * That distinction was previously proven only for the hash-chain *algorithm*
 * (packages/shared's hash-chain.test.ts) and for critical-event *coverage*
 * (audit-chain.e2e.spec.ts), never for the actual *timing* difference between the two tiers.
 * A regression that silently made HID input synchronous (defeating the whole point of
 * buffering -- see ProcessHidInputHandler's docstring on the 60-events/sec hot path) or that
 * broke buffering entirely (making it never flush) would have passed every existing test.
 */
describe("Audit trail: two-tier timing (critical events instant, HID input buffered)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let adminToken: string;
  let operatorToken: string;
  let operatorEmail: string;
  let sessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0); // real socket needed for a real HID_INPUT emission -- see websocket-gateway.e2e.spec.ts
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const prisma = testPrisma();
    const tenant = await createTenant(prisma, `AuditTiming-${crypto.randomUUID()}`);
    const admin = await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN });
    adminToken = admin.accessToken;
    const operator = await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.OPERATOR });
    operatorToken = operator.accessToken;
    operatorEmail = operator.email;

    const http = request(baseUrl);
    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ name: "Timing-Test-MRI", pikvmHost: "https://192.0.2.1", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(201);
    await prisma.equipment.update({ where: { id: equipmentRes.body.id }, data: { status: "ONLINE" } });

    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: equipmentRes.body.id })
      .expect(201);
    sessionId = sessionRes.body.id;
    await prisma.$disconnect();
  }, 20000);

  afterAll(async () => {
    await request(baseUrl).post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`);
    await app.close();
  });

  it("makes a critical event (LOGIN_FAILURE) queryable immediately, with no flush wait", async () => {
    const http = request(baseUrl);

    // No PiKVM involved (unlike PRINT_TEXT/HID input), so nothing here can be confounded with
    // an unrelated network timeout -- a clean measurement of the audit write path alone.
    await http.post("/auth/login").send({ email: operatorEmail, password: "WrongPassword123!", clientOs: "MACOS" }).expect(401);

    // Deliberately no wait at all between the triggering request and the query: that is
    // exactly the claim under test.
    const res = await http.get(`/audit?limit=500`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(res.body.some((e: { action: string }) => e.action === "LOGIN_FAILURE")).toBe(true);
  });

  it("does not record HID input immediately, but flushes it as one INPUT_BATCH row after AUDIT_FLUSH_INTERVAL_MS", async () => {
    const http = request(baseUrl);
    const socket: Socket = io(baseUrl, {
      path: "/rt",
      transports: ["websocket"],
      auth: { token: operatorToken },
      autoConnect: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", reject);
      socket.connect();
    });
    socket.emit(RT_EVENTS.JOIN_SESSION, { sessionId });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // A distinctive marker coordinate, so the later assertion can prove it's specifically
    // *this* input that got flushed, not some unrelated batch. Must stay within PiKVM's
    // absolute HID space (-32768..32767, see MouseMoveEventSchema) or the gateway's own
    // schema check silently drops it before it ever reaches the buffer.
    const marker = { type: "mouse_move" as const, x: 12345, y: -6789, ts: performance.now() };
    socket.emit(RT_EVENTS.HID_INPUT, marker);
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the gateway/handler process the emit itself

    const beforeFlush = await http.get(`/audit?sessionId=${sessionId}&limit=200`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(beforeFlush.body.some((e: { action: string }) => e.action === "INPUT_BATCH")).toBe(false);

    // Same ~5.5s convention already established for PiKVM-flush-adjacent waits elsewhere in
    // this suite (see websocket-gateway.e2e.spec.ts's PRINT_TEXT delivery test) -- comfortably
    // past the default 5000ms AUDIT_FLUSH_INTERVAL_MS, accepted as non-flaky in this codebase.
    await new Promise((resolve) => setTimeout(resolve, 5500));

    const afterFlush = await http.get(`/audit?sessionId=${sessionId}&limit=200`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    const batch = afterFlush.body.find((e: { action: string }) => e.action === "INPUT_BATCH");
    expect(batch).toBeDefined();
    expect(batch.details.events.some((e: { event: typeof marker }) => e.event.x === marker.x && e.event.y === marker.y)).toBe(true);

    socket.disconnect();
  }, 10000);
});
