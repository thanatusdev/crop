import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

describe("Multi-tenant isolation and RBAC", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  let alphaTenantId: string;
  let betaTenantId: string;
  let alphaAdminToken: string;
  let alphaOperatorToken: string;
  let alphaAuditorToken: string;
  let betaOperatorToken: string;
  let alphaEquipmentId: string;
  let prisma: ReturnType<typeof testPrisma>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const alpha = await createTenant(prisma, `Alpha-${crypto.randomUUID()}`);
    const beta = await createTenant(prisma, `Beta-${crypto.randomUUID()}`);
    alphaTenantId = alpha.id;
    betaTenantId = beta.id;

    alphaAdminToken = (await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.CLINIC_ADMIN })).accessToken;
    alphaOperatorToken = (await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.OPERATOR })).accessToken;
    alphaAuditorToken = (await createLoggedInUser(app, { tenantId: alpha.id, role: UserRole.AUDITOR })).accessToken;
    betaOperatorToken = (await createLoggedInUser(app, { tenantId: beta.id, role: UserRole.OPERATOR })).accessToken;

    const createRes = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({
        name: "MRI-Isolation-Test",
        pikvmHost: "https://192.0.2.1", // TEST-NET-1, guaranteed non-routable
        pikvmUser: "admin",
        pikvmPassword: "admin",
        targetOs: "WINDOWS",
      })
      .expect(201);
    alphaEquipmentId = createRes.body.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("lets a tenant's own operator list its equipment", async () => {
    const res = await http.get("/equipment").set("Authorization", `Bearer ${alphaOperatorToken}`).expect(200);
    expect(res.body.map((e: { id: string }) => e.id)).toContain(alphaEquipmentId);
  });

  it("never returns another tenant's equipment in a list, even implicitly", async () => {
    const res = await http.get("/equipment").set("Authorization", `Bearer ${betaOperatorToken}`).expect(200);
    expect(res.body.map((e: { id: string }) => e.id)).not.toContain(alphaEquipmentId);
  });

  it("returns 403, not 404, when fetching another tenant's equipment by id directly", async () => {
    const res = await http
      .get(`/equipment/${alphaEquipmentId}`)
      .set("Authorization", `Bearer ${betaOperatorToken}`)
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("lets the owning tenant fetch its own equipment by id", async () => {
    await http.get(`/equipment/${alphaEquipmentId}`).set("Authorization", `Bearer ${alphaOperatorToken}`).expect(200);
  });

  it("rejects an OPERATOR creating equipment (CLINIC_ADMIN/PLATFORM_ADMIN only)", async () => {
    const res = await http
      .post("/equipment")
      .set("Authorization", `Bearer ${alphaOperatorToken}`)
      .send({ name: "Should Not Be Created", pikvmHost: "https://192.0.2.2", pikvmUser: "a", pikvmPassword: "b", targetOs: "WINDOWS" })
      .expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("rejects an OPERATOR reading the audit log (AUDITOR/SUPERVISOR/*_ADMIN only)", async () => {
    await http.get("/audit").set("Authorization", `Bearer ${alphaOperatorToken}`).expect(403);
  });

  it("allows an AUDITOR to read the audit log", async () => {
    await http.get("/audit").set("Authorization", `Bearer ${alphaAuditorToken}`).expect(200);
  });

  it("rejects any request with no token at all", async () => {
    await http.get("/equipment").expect(401);
  });

  it("rejects a request with a garbage token", async () => {
    await http.get("/equipment").set("Authorization", "Bearer not-a-real-token").expect(401);
  });
});
