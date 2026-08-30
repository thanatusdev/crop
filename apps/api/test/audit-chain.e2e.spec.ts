import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma } from "./helpers.js";

describe("Audit trail: coverage and hash-chain integrity", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: ReturnType<typeof testPrisma>;
  let tenantId: string;
  let adminEmail: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    const tenant = await createTenant(prisma, `AuditChain-${crypto.randomUUID()}`);
    tenantId = tenant.id;

    const admin = await createLoggedInUser(app, { tenantId, role: UserRole.CLINIC_ADMIN });
    adminToken = admin.accessToken;
    adminEmail = admin.email;

    // Deliberately fail a login for the same user, to prove LOGIN_FAILURE is actually
    // recorded -- this exact gap (login was never audited at all) was caught while writing
    // this test, not by inspection. See LoginHandler/VerifyMfaHandler.
    await http.post("/auth/login").send({ email: adminEmail, password: "WrongPassword123!", clientOs: "MACOS" }).expect(401);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it("records LOGIN_FAILURE, MFA_CHALLENGE_SENT, and LOGIN_SUCCESS for the real login flow that just happened", async () => {
    const res = await http.get("/audit?limit=500").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const actions = res.body.map((log: { action: string }) => log.action);

    expect(actions).toContain("LOGIN_FAILURE");
    expect(actions).toContain("MFA_CHALLENGE_SENT");
    expect(actions).toContain("LOGIN_SUCCESS");
  });

  it("chains every row's hash to the previous row, in increasing sequence order", async () => {
    const res = await http.get("/audit?limit=500").set("Authorization", `Bearer ${adminToken}`).expect(200);
    const bySeq = [...res.body].sort((a, b) => a.seq - b.seq);

    expect(bySeq[0].prevHash).toBeNull();
    for (let i = 1; i < bySeq.length; i++) {
      expect(bySeq[i].prevHash).toBe(bySeq[i - 1].hash);
    }
  });

  it("verifies as intact before any tampering", async () => {
    const res = await http.get("/audit/verify").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(res.body).toEqual({ valid: true, checkedRows: expect.any(Number), brokenAtSeq: null });
  });

  it("detects tampering the moment a row's payload is altered directly in the database", async () => {
    const before = await http.get("/audit/verify").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(before.body.valid).toBe(true);

    const target = await prisma.auditLog.findFirst({ where: { tenantId, action: "LOGIN_SUCCESS" } });
    expect(target).not.toBeNull();

    // The append-only trigger (prisma/migrations/*_audit_append_only) blocks UPDATE
    // unconditionally, including for the table owner -- see docs/architecture.md. That is
    // precisely what makes this untestable through any normal application code path, so this
    // test reaches for privileged, trigger-disabling access that the running API itself never
    // has and never will: proving detection works end-to-end, not just the pure algorithm
    // (already covered by packages/shared's hash-chain.test.ts), requires actually tampering
    // a real row and asking the real endpoint to notice.
    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`);
    try {
      await prisma.auditLog.update({
        where: { id: target!.id },
        data: { details: { tampered: true } },
      });
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`);
    }

    const after = await http.get("/audit/verify").set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(after.body.valid).toBe(false);
    expect(after.body.brokenAtSeq).toBe(target!.seq);
  });

  it("still blocks UPDATE/DELETE through the ordinary (non-privileged) path", async () => {
    const target = await prisma.auditLog.findFirst({ where: { tenantId } });
    await expect(prisma.auditLog.update({ where: { id: target!.id }, data: { action: "HACKED" } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: target!.id } })).rejects.toThrow();
  });
});
