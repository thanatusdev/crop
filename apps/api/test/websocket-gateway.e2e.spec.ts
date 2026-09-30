import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * Regression test for a real bug found while load-testing this phase: `MediaStreamServer`
 * used to self-attach an 'upgrade' listener via `ws`'s `{ server, path }` convenience
 * constructor, which fires for *every* upgrade request regardless of path and destroys the
 * raw socket on a path mismatch -- corrupting a connection Socket.io's own engine.io handler
 * had already claimed for `/rt`. See docs/architecture.md and MediaStreamServer's own
 * docstring for the full story. No earlier test caught this because no earlier test both (a)
 * had `MediaStreamServer` active and (b) connected an actual Socket.io client -- every other
 * e2e spec exercises REST endpoints only.
 *
 * This test needs a real HTTP server actually listening on a real port (unlike the other e2e
 * specs, which only need `app.getHttpServer()` for supertest): Socket.io's client performs a
 * real WebSocket upgrade over a real TCP connection, which supertest's in-memory approach
 * doesn't exercise.
 */
describe("WebSocket gateway coexists with the media stream server", () => {
  let app: INestApplication;
  let baseUrl: string;
  let adminToken: string;
  let operatorToken: string;
  let sessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0); // real socket, OS-assigned port -- see the class docstring above
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const prisma = testPrisma();
    const tenant = await createTenant(prisma, `WsGateway-${crypto.randomUUID()}`);
    const admin = await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN });
    adminToken = admin.accessToken;
    const operator = await createContractedOperator(app, prisma, { clinicTenantId: tenant.id, role: UserRole.OPERATOR });
    operatorToken = operator.accessToken;

    const http = request(baseUrl);
    const equipmentRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send(equipmentPayload({ name: "WS-Test-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    await prisma.equipment.update({ where: { id: equipmentRes.body.id }, data: { status: "ONLINE" } });

    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: equipmentRes.body.id })
      .expect(201);
    sessionId = sessionRes.body.id;
    await prisma.$disconnect();
  });

  afterAll(async () => {
    await request(baseUrl).post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`);
    await app.close();
  });

  it("connects, joins a session, and forwards HID input without the connection being corrupted", async () => {
    const socket: Socket = io(baseUrl, {
      path: "/rt",
      transports: ["websocket"],
      auth: { token: operatorToken },
      autoConnect: false,
    });

    const connectionError: Error | null = await new Promise((resolve) => {
      socket.on("connect", () => resolve(null));
      socket.on("connect_error", (err: Error) => resolve(err));
      socket.connect();
    });
    expect(connectionError).toBeNull();

    socket.emit(RT_EVENTS.JOIN_SESSION, { sessionId });
    await new Promise((resolve) => setTimeout(resolve, 200)); // give the gateway a moment to process the join

    const pong = await new Promise<{ clientTs: number; serverTs: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No latency:pong received")), 3000);
      socket.on(RT_EVENTS.LATENCY_PONG, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      socket.emit(RT_EVENTS.LATENCY_PING, { clientTs: performance.now() });
    });
    expect(pong.serverTs).toBeGreaterThan(0);

    // The actual regression check: send real HID input over the same connection and confirm
    // the socket is still alive and well afterward -- a corrupted frame stream (the original
    // bug) would have already surfaced as a transport-level error by this point, not here.
    socket.emit(RT_EVENTS.HID_INPUT, { type: "mouse_move", x: 0, y: 0, ts: performance.now() });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.connected).toBe(true);

    socket.disconnect();
  });

  it("validates print-text against PrintTextRequestSchema -- rejects invalid, accepts valid", async () => {
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

    // Invalid shapes are rejected at the gateway's schema check, before ever reaching
    // PrintTextHandler/PiKVM -- fast, no device round trip, and the connection survives.
    socket.emit(RT_EVENTS.PRINT_TEXT, { text: "" }); // empty, fails .min(1)
    socket.emit(RT_EVENTS.PRINT_TEXT, { text: "x".repeat(2000) }); // too long, fails .max(1024)
    socket.emit(RT_EVENTS.PRINT_TEXT, {}); // missing `text` entirely
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(socket.connected).toBe(true);

    const http = request(baseUrl);
    const noneAudited = await http.get(`/audit?sessionId=${sessionId}&limit=200`).set("Authorization", `Bearer ${adminToken}`);
    expect(noneAudited.body.some((e: { action: string }) => e.action === "PRINT_TEXT")).toBe(false);

    // A valid payload reaches PrintTextHandler (and, in turn, PiKVM's unreachable-in-tests
    // host, hence the wait matching every other PiKVM-REST-call test in this suite).
    socket.emit(RT_EVENTS.PRINT_TEXT, { text: "Patient-01" });
    await new Promise((resolve) => setTimeout(resolve, 5500));

    const audited = await http.get(`/audit?sessionId=${sessionId}&limit=200`).set("Authorization", `Bearer ${adminToken}`);
    const printEvent = audited.body.find((e: { action: string }) => e.action === "PRINT_TEXT");
    expect(printEvent).toBeDefined();
    // Attempted-but-undeliverable (this fixture's PiKVM host is deliberately unreachable) is
    // still audited, not silently dropped -- see PrintTextHandler's own comment on why an
    // unguarded device-call rejection used to skip the audit dispatch entirely.
    expect(printEvent.details.delivered).toBe(false);
    expect(printEvent.details.length).toBe("Patient-01".length);

    socket.disconnect();
  });
});
