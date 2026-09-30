import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole, clinicDayBounds, todayClinicDayString } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * The nursing screen's "N Pacientes Hoje" day-scoped queue view (`GET /queue?date=`) -- see
 * `ListQueueByEquipmentQuery`'s own docstring for why omitting `date` must stay exactly the
 * pre-existing unscoped behaviour (DashboardPage's own patient-queue table, and the
 * session-start "find the next WAITING patient" flow, both call this with no `date` at all).
 * What a schema/handler read alone wouldn't prove:
 *
 *  1. A `date` filter actually excludes yesterday's/tomorrow's entries, in the *clinic's*
 *     configured timezone, not the server process's own TZ or UTC calendar days.
 *  2. An entry with a null `scheduledAt` falls back to `createdAt` for day-bucketing, rather
 *     than disappearing from every day's view.
 *  3. `date` is entirely optional and additive: the old, no-`date` call shape still returns
 *     every entry regardless of day.
 *  4. A malformed `date` is a real 400, not silently ignored.
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

describe("Queue day view (nursing 'N Pacientes Hoje')", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let adminToken: string;
  let nurseToken: string;
  let equipmentId: string;

  const today = todayClinicDayString();

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `QueueDayView-${crypto.randomUUID()}`);
    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    nurseToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.NURSING, emailPrefix: "nurse" })).accessToken;

    equipmentId = await createOnlineEquipment(http, adminToken, prisma, "DayView-MRI-1");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  async function createQueueEntry(patientFirstName: string): Promise<string> {
    const res = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId, patientFirstName })
      .expect(201);
    return res.body.id;
  }

  it("filters to entries whose scheduledAt (or createdAt, when null) falls in the given clinic day", async () => {
    const todayBounds = clinicDayBounds(today);
    const yesterdayMidpoint = new Date(todayBounds.gte.getTime() - 12 * 60 * 60 * 1000);
    const yesterdayDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(yesterdayMidpoint);

    const scheduledToday = await createQueueEntry("Scheduled-Today");
    await prisma.queueEntry.update({
      where: { id: scheduledToday },
      data: { scheduledAt: new Date(todayBounds.gte.getTime() + 5 * 60 * 60 * 1000) }, // 05:00 into today
    });

    const scheduledYesterday = await createQueueEntry("Scheduled-Yesterday");
    await prisma.queueEntry.update({ where: { id: scheduledYesterday }, data: { scheduledAt: yesterdayMidpoint } });

    const noScheduleCreatedToday = await createQueueEntry("NoSchedule-CreatedToday");
    // createdAt defaults to now() at creation time, which already is "today" -- no override
    // needed, this entry proves the null-scheduledAt fallback for free.

    const noScheduleCreatedYesterday = await createQueueEntry("NoSchedule-CreatedYesterday");
    await prisma.queueEntry.update({ where: { id: noScheduleCreatedYesterday }, data: { createdAt: yesterdayMidpoint } });

    const todayRes = await http.get(`/queue?equipmentId=${equipmentId}&date=${today}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    const todayIds = todayRes.body.map((e: { id: string }) => e.id);
    expect(todayIds).toContain(scheduledToday);
    expect(todayIds).toContain(noScheduleCreatedToday);
    expect(todayIds).not.toContain(scheduledYesterday);
    expect(todayIds).not.toContain(noScheduleCreatedYesterday);

    const yesterdayRes = await http
      .get(`/queue?equipmentId=${equipmentId}&date=${yesterdayDay}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .expect(200);
    const yesterdayIds = yesterdayRes.body.map((e: { id: string }) => e.id);
    expect(yesterdayIds).toContain(scheduledYesterday);
    expect(yesterdayIds).toContain(noScheduleCreatedYesterday);
    expect(yesterdayIds).not.toContain(scheduledToday);
    expect(yesterdayIds).not.toContain(noScheduleCreatedToday);
  });

  it("omitting date returns every entry regardless of day -- the pre-existing unscoped call shape", async () => {
    const equipmentId2 = await createOnlineEquipment(http, adminToken, prisma, "DayView-MRI-2");
    const recentRes = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId: equipmentId2, patientFirstName: "Unscoped-Recent" })
      .expect(201);
    const oldEntry = await http
      .post("/queue")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ equipmentId: equipmentId2, patientFirstName: "Unscoped-Old" })
      .expect(201);
    await prisma.queueEntry.update({
      where: { id: oldEntry.body.id },
      data: { createdAt: new Date("2020-01-01T00:00:00.000Z"), scheduledAt: new Date("2020-01-01T00:00:00.000Z") },
    });

    const res = await http.get(`/queue?equipmentId=${equipmentId2}`).set("Authorization", `Bearer ${nurseToken}`).expect(200);
    const ids = res.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(recentRes.body.id);
    expect(ids).toContain(oldEntry.body.id);
  });

  it("rejects a malformed date", async () => {
    const res = await http
      .get(`/queue?equipmentId=${equipmentId}&date=28-09-2026`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});
