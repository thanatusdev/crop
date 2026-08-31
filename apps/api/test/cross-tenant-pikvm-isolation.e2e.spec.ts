import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { RT_EVENTS, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * `PiKvmConnectionRegistry` (apps/api/src/modules/sessions/infrastructure/pikvm-connection-registry.ts)
 * keeps one entry per `equipmentId` in a single in-process `Map`, shared by every tenant's
 * session in this one API instance -- there is no per-tenant partitioning at the data
 * structure level, only the fact that every `equipmentId` already implies exactly one tenant
 * (Equipment.tenantId). That structure is sound by inspection, but nothing before this test
 * ever actually proved that one tenant's PiKVM failure can't stall or corrupt a *different*
 * tenant's concurrently running session -- the closest prior evidence was a one-off manual
 * hardware spike (see docs/architecture.md's Day 2 notes), never an automated, repeatable
 * check.
 *
 * `EndSessionHandler` awaits `PiKvmGatewayPort.release()`, which itself awaits a real HTTP
 * round trip to the device (`PiKvmDevice.disconnect()`) -- against this suite's standard
 * deliberately-unreachable fixture host, that blocks the *HTTP response* for the client's
 * full request timeout (~5s, see PiKvmHidClient). That stall is exactly the tool this test
 * needs: it fires tenant A's session-end (which will block for ~5s against a dead PiKVM)
 * *without awaiting it*, and drives tenant B's entire independent HID input -> buffer -> flush
 * cycle *while A is still stalled*, proving the two are not serialized on any shared lock.
 */
describe("Cross-tenant PiKVM-failure isolation", () => {
  let app: INestApplication;
  let baseUrl: string;
  let adminAToken: string;
  let operatorAToken: string;
  let sessionAId: string;
  let adminBToken: string;
  let operatorBToken: string;
  let sessionBId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0); // real socket needed for tenant B's real HID_INPUT emission
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    const http = request(baseUrl);

    const prisma = testPrisma();

    const tenantA = await createTenant(prisma, `CrossTenantIso-A-${crypto.randomUUID()}`);
    const adminA = await createLoggedInUser(app, { tenantId: tenantA.id, role: UserRole.CLINIC_ADMIN });
    adminAToken = adminA.accessToken;
    const operatorA = await createLoggedInUser(app, { tenantId: tenantA.id, role: UserRole.OPERATOR });
    operatorAToken = operatorA.accessToken;
    const equipmentA = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Iso-Test-MRI-A", pikvmHost: "https://192.0.2.1", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(201);
    await prisma.equipment.update({ where: { id: equipmentA.body.id }, data: { status: "ONLINE" } });
    const sessionA = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorAToken}`)
      .send({ equipmentId: equipmentA.body.id })
      .expect(201);
    sessionAId = sessionA.body.id;

    // A distinct unreachable host from tenant A's -- both "fail" against the real device the
    // same way (neither is real hardware, same as every other e2e fixture), but this keeps
    // them unambiguously two separate PiKvmConnectionRegistry entries, never one shared by
    // accident (e.g. a bug that keyed the registry by host instead of by equipmentId).
    const tenantB = await createTenant(prisma, `CrossTenantIso-B-${crypto.randomUUID()}`);
    const adminB = await createLoggedInUser(app, { tenantId: tenantB.id, role: UserRole.CLINIC_ADMIN });
    adminBToken = adminB.accessToken;
    const operatorB = await createLoggedInUser(app, { tenantId: tenantB.id, role: UserRole.OPERATOR });
    operatorBToken = operatorB.accessToken;
    const equipmentB = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ name: "Iso-Test-CT-B", pikvmHost: "https://192.0.2.2", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(201);
    await prisma.equipment.update({ where: { id: equipmentB.body.id }, data: { status: "ONLINE" } });
    const sessionB = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorBToken}`)
      .send({ equipmentId: equipmentB.body.id })
      .expect(201);
    sessionBId = sessionB.body.id;

    await prisma.$disconnect();
  }, 20000);

  afterAll(async () => {
    await app.close();
  });

  it("keeps tenant B's session fully functional while tenant A's session-end is still stalled against its dead PiKVM", async () => {
    const http = request(baseUrl);

    // Fired but deliberately NOT awaited yet: this is the ~5s-blocked call whose in-flight
    // window tenant B's whole operation below has to run inside.
    const endAPromise = http.post(`/sessions/${sessionAId}/end`).set("Authorization", `Bearer ${operatorAToken}`);

    const socketB: Socket = io(baseUrl, {
      path: "/rt",
      transports: ["websocket"],
      auth: { token: operatorBToken },
      autoConnect: false,
    });
    await new Promise<void>((resolve, reject) => {
      socketB.on("connect", () => resolve());
      socketB.on("connect_error", reject);
      socketB.connect();
    });
    socketB.emit(RT_EVENTS.JOIN_SESSION, { sessionId: sessionBId });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const marker = { type: "mouse_move" as const, x: 555, y: -555, ts: performance.now() };
    socketB.emit(RT_EVENTS.HID_INPUT, marker);

    // Comfortably covers both tenant A's ~5s PiKVM-release stall and tenant B's own
    // AUDIT_FLUSH_INTERVAL_MS (default 5000ms) -- same ~5.5s convention used elsewhere in
    // this suite (see audit-two-tier-timing.e2e.spec.ts).
    await new Promise((resolve) => setTimeout(resolve, 5500));

    // Tenant B's independent input pipeline completed its full buffer -> flush cycle on its
    // own timeline, never blocked by tenant A's still-in-flight (or, by now, just-finished)
    // PiKVM release call.
    expect(socketB.connected).toBe(true);
    const auditB = await http.get(`/audit?sessionId=${sessionBId}&limit=200`).set("Authorization", `Bearer ${adminBToken}`).expect(200);
    const batchB = auditB.body.find((e: { action: string }) => e.action === "INPUT_BATCH");
    expect(batchB).toBeDefined();
    expect(batchB.details.events.some((e: { event: typeof marker }) => e.event.x === marker.x && e.event.y === marker.y)).toBe(true);

    const sessionBStatus = await http.get(`/sessions/${sessionBId}`).set("Authorization", `Bearer ${operatorBToken}`).expect(200);
    expect(sessionBStatus.body.status).toBe("ACTIVE");

    // Tenant A's own stalled call resolves normally (not corrupted, not hung forever) once
    // its PiKVM release attempt finally times out -- the failure was contained to tenant A's
    // own request, never propagated as a crash or as a stall on tenant B.
    const endARes = await endAPromise;
    expect(endARes.status).toBe(201);
    const auditA = await http.get(`/audit?sessionId=${sessionAId}&limit=200`).set("Authorization", `Bearer ${adminAToken}`).expect(200);
    expect(auditA.body.some((e: { action: string }) => e.action === "SESSION_END")).toBe(true);

    // Tenant isolation holds in both directions: neither tenant's audit query ever surfaces
    // the other's session activity.
    expect(auditA.body.some((e: { sessionId: string }) => e.sessionId === sessionBId)).toBe(false);
    expect(auditB.body.some((e: { sessionId: string }) => e.sessionId === sessionAId)).toBe(false);

    socketB.disconnect();
    await http.post(`/sessions/${sessionBId}/end`).set("Authorization", `Bearer ${operatorBToken}`);
  }, 20000);
});
