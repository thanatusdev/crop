import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/** Equipment only becomes ONLINE via the health poller reaching a real device; there is
 * none in this test environment, so fixture setup flips it directly -- exactly the kind of
 * thing that's legitimate in test *setup* but would never be acceptable in an assertion. */
async function createOnlineEquipment(
  http: ReturnType<typeof request>,
  adminToken: string,
  prisma: ReturnType<typeof testPrisma>,
  name: string
): Promise<string> {
  const res = await http
    .post("/equipment")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name, pikvmHost: "https://192.0.2.1", pikvmUser: "admin", pikvmPassword: "admin", targetOs: "WINDOWS" })
    .expect(201);
  await prisma.equipment.update({ where: { id: res.body.id }, data: { status: "ONLINE" } });
  return res.body.id;
}

describe("Session lifecycle", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let tenantId: string;
  let otherTenantId: string;
  let adminToken: string;
  let operatorToken: string;
  let otherOperatorInSameTenantToken: string;
  let otherTenantOperatorToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `SessionLifecycle-${crypto.randomUUID()}`);
    const otherTenant = await createTenant(prisma, `SessionLifecycleOther-${crypto.randomUUID()}`);
    tenantId = tenant.id;
    otherTenantId = otherTenant.id;

    adminToken = (await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN })).accessToken;
    operatorToken = (await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR })).accessToken;
    otherOperatorInSameTenantToken = (await createLoggedInUser(app, { tenantId, role: UserRole.OPERATOR })).accessToken;
    otherTenantOperatorToken = (await createLoggedInUser(app, { tenantId: otherTenantId, role: UserRole.OPERATOR })).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "Lifecycle-MRI");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("refuses to start a session on offline equipment", async () => {
    const offlineRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Offline-MRI", pikvmHost: "https://192.0.2.9", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(201);

    const res = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: offlineRes.body.id })
      .expect(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("refuses a second concurrent session on equipment that already has one active", async () => {
    const dedicatedEquipmentId = await createOnlineEquipment(http, adminToken, prisma, `Exclusivity-Test-${crypto.randomUUID()}`);

    const first = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: dedicatedEquipmentId })
      .expect(201);

    // A different operator -- even in the same tenant -- must not be able to start a second,
    // independent session against equipment that's already claimed by the first. Without
    // this, two people could end up with no coordination sending input to the same physical
    // console. See sessions_one_active_per_equipment.
    const res = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${otherOperatorInSameTenantToken}`)
      .send({ equipmentId: dedicatedEquipmentId })
      .expect(409);
    expect(res.body.code).toBe("CONFLICT");

    await http.post(`/sessions/${first.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);

    // Once released, the equipment is claimable again.
    const second = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${otherOperatorInSameTenantToken}`)
      .send({ equipmentId: dedicatedEquipmentId })
      .expect(201);
    await http.post(`/sessions/${second.body.id}/end`).set("Authorization", `Bearer ${otherOperatorInSameTenantToken}`).expect(201);
  });

  it("starts a session as ACTIVE, with the starting operator as controller", async () => {
    const res = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId })
      .expect(201);

    expect(res.body.status).toBe("ACTIVE");
    expect(res.body.operatorId).toBeTruthy();
    expect(res.body.controllerUserId).toBe(res.body.operatorId);

    await http.post(`/sessions/${res.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
  });

  it("returns 403 -- not 404, not the session's data -- when a different tenant reads it by id", async () => {
    const startRes = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId }).expect(201);
    const sessionId = startRes.body.id;

    const res = await http.get(`/sessions/${sessionId}`).set("Authorization", `Bearer ${otherTenantOperatorToken}`).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
  });

  it("refuses to end a session for a user who is not its operator or supervisor", async () => {
    const startRes = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId }).expect(201);
    const sessionId = startRes.body.id;

    const res = await http
      .post(`/sessions/${sessionId}/end`)
      .set("Authorization", `Bearer ${otherOperatorInSameTenantToken}`)
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    await http.post(`/sessions/${sessionId}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
  });

  it("enforces the per-operator concurrent session limit", async () => {
    const equipmentIds = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createOnlineEquipment(http, adminToken, prisma, `Limit-Test-${i}-${crypto.randomUUID()}`))
    );

    const startResults = await Promise.all(
      equipmentIds.slice(0, 3).map((id) =>
        http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: id }).expect(201)
      )
    );
    const startedSessionIds = startResults.map((res) => res.body.id);

    // MAX_CONCURRENT_SESSIONS_PER_OPERATOR defaults to 3 -- the 4th must be refused.
    const res = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: equipmentIds[3] })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");

    await Promise.all(
      startedSessionIds.map((id) => http.post(`/sessions/${id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201))
    );
  });

  it("moves a queue entry through WAITING -> IN_PROGRESS -> DONE as its session starts and ends, so the same equipment can serve the next patient afterward", async () => {
    // A real bug found manually demoing this: `Session.queueEntryId` is `@unique` (one
    // session per queue entry, ever -- not just one *active* one), but nothing ever moved a
    // queue entry off WAITING when a session started against it. The dashboard's "next
    // waiting patient" picker kept re-selecting the *same*, already-consumed entry on every
    // subsequent "Start session" click, which always collided on that unique constraint --
    // misreported, on top of that, as "Equipment already has an active session" (a
    // completely different, unrelated conflict). See PrismaSessionRepository/
    // StartSessionHandler/EndSessionHandler's own comments.
    const dedicatedEquipmentId = await createOnlineEquipment(http, adminToken, prisma, `Queue-Sync-${crypto.randomUUID()}`);

    const patientRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId: dedicatedEquipmentId, patientFirstName: "Carlos" })
      .expect(201);
    const queueEntryId = patientRes.body.id;
    expect(patientRes.body.status).toBe("WAITING");

    const sessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: dedicatedEquipmentId, queueEntryId })
      .expect(201);

    const duringSession = await http
      .get(`/queue?equipmentId=${dedicatedEquipmentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(duringSession.body.find((e: { id: string }) => e.id === queueEntryId).status).toBe("IN_PROGRESS");

    await http.post(`/sessions/${sessionRes.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);

    const afterEnd = await http
      .get(`/queue?equipmentId=${dedicatedEquipmentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(afterEnd.body.find((e: { id: string }) => e.id === queueEntryId).status).toBe("DONE");

    // The actual regression check: starting a brand new session against the SAME equipment
    // (with no queueEntryId this time, since the one and only patient is now DONE) must not
    // 409 on a stale, already-consumed queueEntryId anywhere in the stack.
    const secondSessionRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ equipmentId: dedicatedEquipmentId })
      .expect(201);
    await http.post(`/sessions/${secondSessionRes.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
  });

  // `AbortIdleSessionHandler`'s equivalent transition (queue entry -> CANCELLED, not back to
  // WAITING, when a session aborts on idle timeout) is NOT covered by a dedicated e2e test
  // here: genuinely triggering it means waiting out SESSION_IDLE_TIMEOUT_MS for real, and
  // this suite deliberately never does multi-minute waits (see this file's other tests, all
  // driven by real HTTP/device timeouts already in the single-digit seconds). Verified by
  // code inspection instead -- it's the same `queue.updateStatus()` call, at the same point
  // in the same lifecycle, as the two paths this test *does* exercise above, just a
  // different target status. See docs/architecture.md.
});
