import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PlatformStatsSchema, UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

/**
 * `GET /platform/stats` -- the PLATFORM_ADMIN dashboard's cross-tenant totals. The database
 * is shared with every other spec, so counts are asserted as deltas around fixtures this spec
 * creates itself (`>=`, since other specs may add rows concurrently), never as absolutes.
 */
describe("Platform stats", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let platformAdminToken: string;
  let clinicAdminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const platformTenant = await createTenant(prisma, `Platform-${crypto.randomUUID()}`, "PLATFORM");
    platformAdminToken = (await createLoggedInUser(app, { tenantId: platformTenant.id, role: UserRole.PLATFORM_ADMIN })).accessToken;

    const clinic = await createTenant(prisma, `Stats-Clinic-${crypto.randomUUID()}`);
    clinicAdminToken = (await createLoggedInUser(app, { tenantId: clinic.id, role: UserRole.CLINIC_ADMIN })).accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  const getStats = async () => {
    const res = await http.get("/platform/stats").set("Authorization", `Bearer ${platformAdminToken}`).expect(200);
    return PlatformStatsSchema.parse(res.body);
  };

  it("returns platform-wide totals that move with new tenants and users", async () => {
    const before = await getStats();

    await createTenant(prisma, `Stats-New-Clinic-${crypto.randomUUID()}`);
    const operator = await createTenant(prisma, `Stats-New-Operator-${crypto.randomUUID()}`, "OPERATOR_PROVIDER");
    await createLoggedInUser(app, { tenantId: operator.id, role: UserRole.OPERATOR_ADMIN });
    const retired = await createTenant(prisma, `Stats-Retired-Operator-${crypto.randomUUID()}`, "OPERATOR_PROVIDER");
    await prisma.tenant.update({ where: { id: retired.id }, data: { deactivatedAt: new Date() } });

    const after = await getStats();
    expect(after.clinics.active).toBeGreaterThanOrEqual(before.clinics.active + 1);
    expect(after.operators.active).toBeGreaterThanOrEqual(before.operators.active + 1);
    expect(after.operators.deactivated).toBeGreaterThanOrEqual(before.operators.deactivated + 1);
    expect(after.users.total).toBeGreaterThanOrEqual(before.users.total + 1);
    expect(after.users.activeLast30Days).toBeLessThanOrEqual(after.users.total);
    expect(after.equipment.online).toBeLessThanOrEqual(after.equipment.total);
  });

  it("is PLATFORM_ADMIN-only", async () => {
    await http.get("/platform/stats").set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
    await http.get("/platform/stats").expect(401);
  });
});
