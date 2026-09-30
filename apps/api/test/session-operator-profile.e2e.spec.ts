import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createContractedOperator, createTenant, testPrisma, equipmentPayload } from "./helpers.js";

/**
 * `SessionState.operatorName`/`operatorRegistration` -- resolved together by
 * `SessionParticipantNameService.resolveOperatorProfile(s)`, added for the nursing screen's
 * "Operador Remoto" card ("Rafael Moura · CRBM 4289"). Neither field had a dedicated test
 * anywhere before this one (`operatorName` shipped with the earlier patient-preparation
 * feature, untested) -- this covers both together now that `operatorRegistration` exists
 * alongside it.
 */
describe("SessionState operator name + registration", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;

  let adminToken: string;
  let operatorUserId: string;
  let operatorToken: string;
  let equipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `OperatorProfile-${crypto.randomUUID()}`);
    adminToken = (await createLoggedInUser(app, { tenantId: tenant.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    const operator = await createContractedOperator(app, prisma, {
      clinicTenantId: tenant.id,
      role: UserRole.OPERATOR,
      emailPrefix: "operator",
      firstName: "Rafael",
      lastName: "Moura",
    });
    operatorUserId = operator.userId;
    operatorToken = operator.accessToken;
    await prisma.user.update({ where: { id: operatorUserId }, data: { professionalRegistration: "CRBM 4289" } });

    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(equipmentPayload({ name: "OperatorProfile-MRI", pikvmHost: "https://192.0.2.1" }))
      .expect(201);
    equipmentId = res.body.id;
    await prisma.equipment.update({ where: { id: equipmentId }, data: { status: "ONLINE" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("resolves both fields on session start, and on every subsequent read", async () => {
    const startRes = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId }).expect(201);
    expect(startRes.body.operatorName).toBe("Rafael Moura");
    expect(startRes.body.operatorRegistration).toBe("CRBM 4289");

    const getRes = await http.get(`/sessions/${startRes.body.id}`).set("Authorization", `Bearer ${operatorToken}`).expect(200);
    expect(getRes.body.operatorName).toBe("Rafael Moura");
    expect(getRes.body.operatorRegistration).toBe("CRBM 4289");

    const listRes = await http.get("/sessions/active").set("Authorization", `Bearer ${operatorToken}`).expect(200);
    const active = listRes.body.find((s: { id: string }) => s.id === startRes.body.id);
    expect(active.operatorName).toBe("Rafael Moura");
    expect(active.operatorRegistration).toBe("CRBM 4289");

    await http.post(`/sessions/${startRes.body.id}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
  });

  it("is null for an operator with no professionalRegistration on file", async () => {
    const tenant2 = await createTenant(prisma, `OperatorProfileNoReg-${crypto.randomUUID()}`);
    const admin2 = (await createLoggedInUser(app, { tenantId: tenant2.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    const operator2 = await createContractedOperator(app, prisma, { clinicTenantId: tenant2.id, role: UserRole.OPERATOR, emailPrefix: "no-reg-operator" });
    const eqRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${admin2}`)
      .send(equipmentPayload({ name: "NoRegistration-MRI", pikvmHost: "https://192.0.2.2" }))
      .expect(201);
    await prisma.equipment.update({ where: { id: eqRes.body.id }, data: { status: "ONLINE" } });

    const startRes = await http
      .post("/sessions")
      .set("Authorization", `Bearer ${operator2.accessToken}`)
      .send({ equipmentId: eqRes.body.id })
      .expect(201);
    expect(startRes.body.operatorRegistration).toBeNull();

    await http.post(`/sessions/${startRes.body.id}/end`).set("Authorization", `Bearer ${operator2.accessToken}`).expect(201);
  });
});
