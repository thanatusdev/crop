import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { UserRole } from "@crop/shared";
import { createTestApp, createLoggedInUser, createTenant, testPrisma, equipmentPayload, unitPayload } from "./helpers.js";

/**
 * The clinic<->operating-company contract: its handshake, its per-unit/per-equipment scope, and the
 * authorization it actually produces.
 *
 * This replaced `Tenant.operatorTenantId`, a single nullable self-FK a PLATFORM_ADMIN set
 * unilaterally. Three properties that column could not have, and which are therefore what this
 * suite is really about:
 *
 *   1. **Many-to-many.** One clinic, two operating companies, with *different* scope.
 *   2. **A real handshake.** A proposal grants nothing until the other side accepts, and the
 *      proposer cannot accept their own.
 *   3. **Scope.** An ACTIVE agreement is not "run this clinic" -- it names rooms, and everything
 *      outside them is refused on every path that reaches equipment.
 *
 * Deliberately built through HTTP rather than by writing agreement rows with Prisma (which
 * `createContractedOperator` does for other suites' fixtures): the handshake rules live in the
 * entity and the handlers, so a fixture that inserted ACTIVE rows directly would test none of them.
 */
describe("Operator agreements: handshake, scope, and the access they grant", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: PrismaClient;

  let clinicId: string;
  let clinicAdminToken: string;
  let clinicAdminUserId: string;
  let otherClinicId: string;

  let companyAId: string;
  let companyAAdminToken: string;
  let companyBId: string;
  let companyBAdminToken: string;

  let grantedUnitId: string;
  let ungrantedUnitId: string;
  let grantedEquipmentId: string;
  let ungrantedEquipmentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    prisma = testPrisma();

    clinicId = (await createTenant(prisma, `AgreeClinic-${crypto.randomUUID()}`)).id;
    otherClinicId = (await createTenant(prisma, `AgreeOtherClinic-${crypto.randomUUID()}`)).id;
    companyAId = (await createTenant(prisma, `AgreeCompanyA-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    companyBId = (await createTenant(prisma, `AgreeCompanyB-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;

    const clinicAdmin = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.CLINIC_ADMIN, emailPrefix: "agree-clinic-admin" });
    clinicAdminToken = clinicAdmin.accessToken;
    clinicAdminUserId = clinicAdmin.userId;
    companyAAdminToken = (await createLoggedInUser(app, { tenantId: companyAId, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-a-admin" }))
      .accessToken;
    companyBAdminToken = (await createLoggedInUser(app, { tenantId: companyBId, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-b-admin" }))
      .accessToken;

    // Two rooms, each with a scanner. Which is "granted" differs per company, which is the point.
    grantedUnitId = (
      await http.post("/units").set("Authorization", `Bearer ${clinicAdminToken}`).send(unitPayload(clinicAdminUserId, { name: "Ala Norte" })).expect(201)
    ).body.id;
    ungrantedUnitId = (
      await http.post("/units").set("Authorization", `Bearer ${clinicAdminToken}`).send(unitPayload(clinicAdminUserId, { name: "Ala Sul" })).expect(201)
    ).body.id;

    grantedEquipmentId = (
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicAdminToken}`)
        .send(equipmentPayload({ name: "Agree-Granted-MRI", unitId: grantedUnitId }))
        .expect(201)
    ).body.id;
    ungrantedEquipmentId = (
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicAdminToken}`)
        .send(equipmentPayload({ name: "Agree-Ungranted-CT", unitId: ungrantedUnitId }))
        .expect(201)
    ).body.id;
    await prisma.equipment.updateMany({
      where: { id: { in: [grantedEquipmentId, ungrantedEquipmentId] } },
      data: { status: "ONLINE" },
    });
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  /** Logs in a fresh OPERATOR belonging to `companyTenantId` and switches them into `clinicId`. */
  async function operatorInClinic(companyTenantId: string, targetClinicId: string): Promise<string> {
    const operator = await createLoggedInUser(app, { tenantId: companyTenantId, role: UserRole.OPERATOR, emailPrefix: "agree-op" });
    const switched = await http
      .post("/auth/active-clinic")
      .set("Authorization", `Bearer ${operator.accessToken}`)
      .send({ clinicTenantId: targetClinicId })
      .expect(200);
    return switched.body.accessToken as string;
  }

  it("grants nothing while a proposal is merely pending, and refuses to let the proposer accept their own", async () => {
    const proposed = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ operatorTenantId: companyAId, unitIds: [grantedUnitId] })
      .expect(201);
    expect(proposed.body.status).toBe("PENDING");
    expect(proposed.body.clinicTenantId).toBe(clinicId);
    expect(proposed.body.operatorTenantId).toBe(companyAId);

    // The clinic proposed, so the clinic may not accept -- otherwise the handshake is decoration
    // and we are back to the unilateral link this model replaced.
    const selfAccept = await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
    expect(selfAccept.body.code).toBe("FORBIDDEN");

    // And PENDING grants no access at all: the operator cannot even enter the clinic's context.
    const operator = await createLoggedInUser(app, { tenantId: companyAId, role: UserRole.OPERATOR, emailPrefix: "agree-pending-op" });
    const blocked = await http
      .post("/auth/active-clinic")
      .set("Authorization", `Bearer ${operator.accessToken}`)
      .send({ clinicTenantId: clinicId })
      .expect(403);
    expect(blocked.body.code).toBe("FORBIDDEN");

    // A duplicate proposal is a conflict, not a second row -- one agreement per pair.
    const duplicate = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ operatorTenantId: companyAId })
      .expect(409);
    expect(duplicate.body.code).toBe("CONFLICT");

    // Accepted by the counterparty -> ACTIVE, and only now is the clinic reachable.
    const accepted = await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${companyAAdminToken}`).expect(201);
    expect(accepted.body.status).toBe("ACTIVE");
    expect(accepted.body.scopes.map((s: { label: string }) => s.label)).toEqual(["Ala Norte"]);
  });

  it("confines a contracted operator to the scanners its agreement names, on every path that reaches equipment", async () => {
    const operatorToken = await operatorInClinic(companyAId, clinicId);

    // The list is narrowed rather than refused: one of the clinic's two rooms is in scope.
    const list = await http.get("/equipment").set("Authorization", `Bearer ${operatorToken}`).expect(200);
    expect(list.body.map((e: { name: string }) => e.name)).toEqual(["Agree-Granted-MRI"]);

    // Naming the out-of-scope device directly is a 403 on each of the three routes that can reach
    // it -- equipment detail, session start, and the patient queue. The queue matters most: it
    // returns patient first names.
    for (const [label, res] of [
      ["equipment detail", await http.get(`/equipment/${ungrantedEquipmentId}`).set("Authorization", `Bearer ${operatorToken}`)],
      ["session start", await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: ungrantedEquipmentId })],
      ["patient queue", await http.get(`/queue?equipmentId=${ungrantedEquipmentId}`).set("Authorization", `Bearer ${operatorToken}`)],
    ] as const) {
      expect(res.status, `${label} should be refused`).toBe(403);
      expect(res.body.code, `${label} should be FORBIDDEN`).toBe("FORBIDDEN");
    }

    // The in-scope device works end to end, proving the refusals above are about scope and not a
    // blanket loss of access.
    await http.get(`/equipment/${grantedEquipmentId}`).set("Authorization", `Bearer ${operatorToken}`).expect(200);
    const session = await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: grantedEquipmentId }).expect(201);
    await http.post(`/sessions/${session.body.id as string}/end`).set("Authorization", `Bearer ${operatorToken}`).expect(201);
  });

  it("lets one clinic contract a second company with different scope, without either seeing the other's rooms", async () => {
    // Proposed by the *company* this time -- the mirror of the first test's direction.
    const proposed = await http.post("/agreements").set("Authorization", `Bearer ${companyBAdminToken}`).send({ clinicTenantId: clinicId }).expect(201);
    expect(proposed.body.status).toBe("PENDING");

    // The company proposed, so the company may not accept.
    await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${companyBAdminToken}`).expect(403);
    await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(201);

    // Accepted with no scope grants nothing -- the deliberate deny-by-default reading.
    const noScopeToken = await operatorInClinic(companyBId, clinicId);
    const beforeScope = await http.get("/equipment").set("Authorization", `Bearer ${noScopeToken}`).expect(200);
    expect(beforeScope.body).toEqual([]);

    // The clinic grants company B the *other* room.
    await http
      .put(`/agreements/${proposed.body.id}/scope`)
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ unitIds: [ungrantedUnitId], equipmentIds: [] })
      .expect(200);

    const afterScope = await http.get("/equipment").set("Authorization", `Bearer ${await operatorInClinic(companyBId, clinicId)}`).expect(200);
    expect(afterScope.body.map((e: { name: string }) => e.name)).toEqual(["Agree-Ungranted-CT"]);

    // Company A is unaffected and still sees only its own room -- two live contracts, disjoint
    // scope, on one clinic. This is the shape the old single-FK column could not express at all.
    const companyAList = await http.get("/equipment").set("Authorization", `Bearer ${await operatorInClinic(companyAId, clinicId)}`).expect(200);
    expect(companyAList.body.map((e: { name: string }) => e.name)).toEqual(["Agree-Granted-MRI"]);
  });

  it("refuses to let a company scope its own agreement, or a clinic grant another clinic's equipment", async () => {
    const agreements = await http.get("/agreements").set("Authorization", `Bearer ${companyBAdminToken}`).expect(200);
    const agreementId = agreements.body[0].id as string;

    // Scope is the clinic's to set. A company widening its own would make the limit meaningless.
    const selfScope = await http
      .put(`/agreements/${agreementId}/scope`)
      .set("Authorization", `Bearer ${companyBAdminToken}`)
      .send({ unitIds: [grantedUnitId], equipmentIds: [] })
      .expect(403);
    expect(selfScope.body.code).toBe("FORBIDDEN");

    // And a clinic cannot grant what it does not own -- this table *is* the authorization data, so
    // a row naming a foreign unit would be a cross-tenant escalation written straight into it.
    const foreignUnit = await prisma.unit.create({
      data: { clinicTenantId: otherClinicId, name: "Foreign Ala", declaredModalities: [] },
    });
    const foreignGrant = await http
      .put(`/agreements/${agreementId}/scope`)
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ unitIds: [foreignUnit.id], equipmentIds: [] })
      .expect(403);
    expect(foreignGrant.body.code).toBe("FORBIDDEN");
  });

  it("cuts access the moment a clinic revokes, without invalidating the operator's existing token", async () => {
    const company = (await createTenant(prisma, `AgreeRevoke-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyAdmin = (await createLoggedInUser(app, { tenantId: company, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-revoke-admin" }))
      .accessToken;

    const proposed = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ operatorTenantId: company, unitIds: [grantedUnitId] })
      .expect(201);
    await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${companyAdmin}`).expect(201);

    // A token issued *while* the contract was live.
    const operatorToken = await operatorInClinic(company, clinicId);
    expect((await http.get("/equipment").set("Authorization", `Bearer ${operatorToken}`).expect(200)).body).toHaveLength(1);

    const revoked = await http.post(`/agreements/${proposed.body.id}/revoke`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(200);
    expect(revoked.body.status).toBe("REVOKED");

    // That same token now reaches nothing. Revocation is enforced on the data paths rather than by
    // invalidating tokens, which is why this assertion uses the *old* token deliberately.
    expect((await http.get("/equipment").set("Authorization", `Bearer ${operatorToken}`).expect(200)).body).toEqual([]);
    await http.get(`/equipment/${grantedEquipmentId}`).set("Authorization", `Bearer ${operatorToken}`).expect(403);
    await http.post("/sessions").set("Authorization", `Bearer ${operatorToken}`).send({ equipmentId: grantedEquipmentId }).expect(403);
  });

  it("keeps an agreement invisible to organisations that are not party to it", async () => {
    const outsiderClinicAdmin = (
      await createLoggedInUser(app, { tenantId: otherClinicId, role: UserRole.CLINIC_ADMIN, emailPrefix: "agree-outsider" })
    ).accessToken;

    const mine = await http.get("/agreements").set("Authorization", `Bearer ${clinicAdminToken}`).expect(200);
    expect(mine.body.length).toBeGreaterThan(0);

    // The outsider's own list is empty, and naming one of our agreement ids directly is a 403 --
    // the role gate would have let them in, so this proves the per-tenant scoping inside the
    // handler is what actually protects it.
    const theirs = await http.get("/agreements").set("Authorization", `Bearer ${outsiderClinicAdmin}`).expect(200);
    expect(theirs.body).toEqual([]);

    const peek = await http.get(`/agreements/${mine.body[0].id as string}`).set("Authorization", `Bearer ${outsiderClinicAdmin}`).expect(403);
    expect(peek.body.code).toBe("FORBIDDEN");
  });

  it("refuses contract management to roles that run exams rather than sign agreements", async () => {
    const operator = await createLoggedInUser(app, { tenantId: companyAId, role: UserRole.OPERATOR, emailPrefix: "agree-rbac-op" });
    const supervisor = await createLoggedInUser(app, {
      tenantId: companyAId,
      role: UserRole.OPERATIONAL_SUPERVISOR,
      emailPrefix: "agree-rbac-sup",
    });
    const nurse = await createLoggedInUser(app, { tenantId: clinicId, role: UserRole.NURSING, emailPrefix: "agree-rbac-nurse" });

    for (const token of [operator.accessToken, supervisor.accessToken, nurse.accessToken]) {
      await http.get("/agreements").set("Authorization", `Bearer ${token}`).expect(403);
      await http.post("/agreements").set("Authorization", `Bearer ${token}`).send({ clinicTenantId: clinicId }).expect(403);
    }
  });

  /**
   * `GET /agreements/clinic-options` backs the operator-side propose modal's clinic picker.
   * Before this, the frontend called `GET /tenants` -- which only a PLATFORM_ADMIN can reach -- and
   * filtered client-side, so an OPERATOR_ADMIN's own "Propor Contrato" button 403'd on every attempt.
   * This is the OPERATOR_ADMIN-reachable replacement, and it does the exclusion filtering
   * server-side rather than trusting the client to.
   */
  it("lists clinics an operator may propose to, excluding ones it already has a pending or active agreement with", async () => {
    const company = (await createTenant(prisma, `AgreeOptCompany-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyAdmin = (
      await createLoggedInUser(app, { tenantId: company, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-opt-admin" })
    ).accessToken;

    const pendingClinic = (await createTenant(prisma, `AgreeOptPending-${crypto.randomUUID()}`)).id;
    const activeClinic = (await createTenant(prisma, `AgreeOptActive-${crypto.randomUUID()}`)).id;
    const activeClinicAdmin = (
      await createLoggedInUser(app, { tenantId: activeClinic, role: UserRole.CLINIC_ADMIN, emailPrefix: "agree-opt-active-admin" })
    ).accessToken;
    const openClinic = (await createTenant(prisma, `AgreeOptOpen-${crypto.randomUUID()}`)).id;
    const deactivatedClinic = (await createTenant(prisma, `AgreeOptDeactivated-${crypto.randomUUID()}`)).id;
    await prisma.tenant.update({ where: { id: deactivatedClinic }, data: { deactivatedAt: new Date() } });

    await http.post("/agreements").set("Authorization", `Bearer ${companyAdmin}`).send({ clinicTenantId: pendingClinic }).expect(201);
    const activeProposal = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${companyAdmin}`)
      .send({ clinicTenantId: activeClinic })
      .expect(201);
    await http.post(`/agreements/${activeProposal.body.id}/accept`).set("Authorization", `Bearer ${activeClinicAdmin}`).expect(201);

    const options = await http.get("/agreements/clinic-options").set("Authorization", `Bearer ${companyAdmin}`).expect(200);
    const ids = (options.body as { id: string; name: string }[]).map((o) => o.id);

    expect(ids).toContain(openClinic);
    expect(ids).not.toContain(pendingClinic);
    expect(ids).not.toContain(activeClinic);
    expect(ids).not.toContain(deactivatedClinic);

    // Refused, not just filtered, to a role that cannot propose in the first place -- a clinic
    // admin has no use for "which clinics can I propose to" and platform admins structurally
    // cannot propose at all (see `AgreementsPage.tsx`'s `isOperatorSide` docstring).
    await http.get("/agreements/clinic-options").set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
  });

  /**
   * `GET /agreements/operator-options` is the clinic-side mirror of the test immediately above --
   * same exclusion rules, filtered to `OPERATOR_PROVIDER` tenants instead of `CLINIC` ones, backing
   * the clinic-side propose modal's company picker.
   */
  it("lists companies a clinic may propose to, excluding ones it already has a pending or active agreement with", async () => {
    const clinic = (await createTenant(prisma, `AgreeOptClinic-${crypto.randomUUID()}`)).id;
    const clinicAdmin = (
      await createLoggedInUser(app, { tenantId: clinic, role: UserRole.CLINIC_ADMIN, emailPrefix: "agree-opt-clinic-admin" })
    ).accessToken;

    const pendingCompany = (await createTenant(prisma, `AgreeOptPendingCo-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const activeCompany = (await createTenant(prisma, `AgreeOptActiveCo-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const activeCompanyAdmin = (
      await createLoggedInUser(app, { tenantId: activeCompany, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-opt-active-co-admin" })
    ).accessToken;
    const openCompany = (await createTenant(prisma, `AgreeOptOpenCo-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const deactivatedCompany = (await createTenant(prisma, `AgreeOptDeactivatedCo-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    await prisma.tenant.update({ where: { id: deactivatedCompany }, data: { deactivatedAt: new Date() } });

    await http.post("/agreements").set("Authorization", `Bearer ${clinicAdmin}`).send({ operatorTenantId: pendingCompany }).expect(201);
    const activeProposal = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${clinicAdmin}`)
      .send({ operatorTenantId: activeCompany })
      .expect(201);
    await http.post(`/agreements/${activeProposal.body.id}/accept`).set("Authorization", `Bearer ${activeCompanyAdmin}`).expect(201);

    const options = await http.get("/agreements/operator-options").set("Authorization", `Bearer ${clinicAdmin}`).expect(200);
    const ids = (options.body as { id: string; name: string }[]).map((o) => o.id);

    expect(ids).toContain(openCompany);
    expect(ids).not.toContain(pendingCompany);
    expect(ids).not.toContain(activeCompany);
    expect(ids).not.toContain(deactivatedCompany);

    // Refused, not just filtered, to a role that cannot propose from the clinic side -- an
    // operator admin has no use for "which companies can I propose to" (they'd want
    // clinic-options instead), and platform admins structurally cannot propose at all.
    await http.get("/agreements/operator-options").set("Authorization", `Bearer ${companyAAdminToken}`).expect(403);
  });

  it("lets a clinic admin propose directly to an operating company, not just respond to one", async () => {
    const company = (await createTenant(prisma, `AgreeClinicProposes-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyAdmin = (
      await createLoggedInUser(app, { tenantId: company, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-clinic-proposes-admin" })
    ).accessToken;

    const proposed = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ operatorTenantId: company })
      .expect(201);
    expect(proposed.body.status).toBe("PENDING");
    expect(proposed.body.proposedByTenantId).toBe(clinicId);

    // The company, not the clinic, is the one who must answer -- same `assertCanBeRespondedToBy`
    // rule proven for the operator-proposes direction elsewhere in this suite, exercised here in
    // the other direction.
    const selfAccept = await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
    expect(selfAccept.body.code).toBe("FORBIDDEN");

    await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${companyAdmin}`).expect(201);
  });

  it("audits the whole lifecycle against the clinic, since the clinic is the party whose exposure changes", async () => {
    const company = (await createTenant(prisma, `AgreeAudit-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyAdmin = (await createLoggedInUser(app, { tenantId: company, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-audit-admin" }))
      .accessToken;

    const proposed = await http
      .post("/agreements")
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ operatorTenantId: company })
      .expect(201);
    await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${companyAdmin}`).expect(201);
    await http
      .put(`/agreements/${proposed.body.id}/scope`)
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ unitIds: [grantedUnitId], equipmentIds: [] })
      .expect(200);
    await http.post(`/agreements/${proposed.body.id}/revoke`).set("Authorization", `Bearer ${companyAdmin}`).expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { resourceType: "OperatorAgreement", resourceId: proposed.body.id as string },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual([
      "AGREEMENT_PROPOSED",
      "AGREEMENT_ACCEPTED",
      "AGREEMENT_SCOPE_CHANGED",
      "AGREEMENT_REVOKED",
    ]);
    // Against the clinic even for the two acts the *company* performed, so a reviewer reading one
    // clinic's log sees the complete history of who could reach its patients.
    expect(rows.every((r) => r.tenantId === clinicId)).toBe(true);
    // And the revocation records which side walked away -- `revokedByUserId` alone cannot say.
    expect((rows[3]!.details as { revokedByClinic: boolean }).revokedByClinic).toBe(false);
  });

  it("re-proposing after a rejection reuses the same agreement row rather than accumulating history rows", async () => {
    const company = (await createTenant(prisma, `AgreeReopen-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyAdmin = (await createLoggedInUser(app, { tenantId: company, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-reopen-admin" }))
      .accessToken;

    const first = await http.post("/agreements").set("Authorization", `Bearer ${clinicAdminToken}`).send({ operatorTenantId: company }).expect(201);
    const rejected = await http.post(`/agreements/${first.body.id}/reject`).set("Authorization", `Bearer ${companyAdmin}`).expect(201);
    expect(rejected.body.status).toBe("REJECTED");

    const second = await http.post("/agreements").set("Authorization", `Bearer ${clinicAdminToken}`).send({ operatorTenantId: company }).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe("PENDING");
    // The previous round's answer is cleared, so a reopened agreement cannot look already-answered.
    expect(second.body.respondedAt).toBeNull();

    expect(await prisma.operatorAgreement.count({ where: { clinicTenantId: clinicId, operatorTenantId: company } })).toBe(1);
  });

  /**
   * The use case equipment-level scope exists for: two companies working the same room, each
   * cleared for a different scanner in it. A unit-level grant cannot express this at all -- it
   * is all-or-nothing per room -- so this is the one assertion in the suite that a pure
   * unit-grant model could never pass.
   */
  it("lets a clinic grant two companies different scanners in the very same room", async () => {
    const sharedUnit = (
      await http.post("/units").set("Authorization", `Bearer ${clinicAdminToken}`).send(unitPayload(clinicAdminUserId, { name: "Sala Compartilhada" })).expect(201)
    ).body.id;
    const scannerOne = (
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicAdminToken}`)
        .send(equipmentPayload({ name: "Shared-Room-MRI", unitId: sharedUnit }))
        .expect(201)
    ).body.id;
    const scannerTwo = (
      await http
        .post("/equipment")
        .set("Authorization", `Bearer ${clinicAdminToken}`)
        .send(equipmentPayload({ name: "Shared-Room-CT", unitId: sharedUnit }))
        .expect(201)
    ).body.id;
    await prisma.equipment.updateMany({ where: { id: { in: [scannerOne, scannerTwo] } }, data: { status: "ONLINE" } });

    const companyC = (await createTenant(prisma, `AgreeShared-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyCAdmin = (await createLoggedInUser(app, { tenantId: companyC, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-shared-c-admin" }))
      .accessToken;
    const companyD = (await createTenant(prisma, `AgreeShared-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
    const companyDAdmin = (await createLoggedInUser(app, { tenantId: companyD, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-shared-d-admin" }))
      .accessToken;

    const proposedC = await http.post("/agreements").set("Authorization", `Bearer ${clinicAdminToken}`).send({ operatorTenantId: companyC }).expect(201);
    await http.post(`/agreements/${proposedC.body.id}/accept`).set("Authorization", `Bearer ${companyCAdmin}`).expect(201);
    await http
      .put(`/agreements/${proposedC.body.id}/scope`)
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ unitIds: [], equipmentIds: [scannerOne] })
      .expect(200);

    const proposedD = await http.post("/agreements").set("Authorization", `Bearer ${clinicAdminToken}`).send({ operatorTenantId: companyD }).expect(201);
    await http.post(`/agreements/${proposedD.body.id}/accept`).set("Authorization", `Bearer ${companyDAdmin}`).expect(201);
    await http
      .put(`/agreements/${proposedD.body.id}/scope`)
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ unitIds: [], equipmentIds: [scannerTwo] })
      .expect(200);

    // Each company reaches exactly its own scanner in the shared room, and is refused the
    // other -- on both the list and the single-resource path.
    const cToken = await operatorInClinic(companyC, clinicId);
    const cList = await http.get("/equipment").set("Authorization", `Bearer ${cToken}`).expect(200);
    expect(cList.body.map((e: { name: string }) => e.name)).toEqual(["Shared-Room-MRI"]);
    await http.get(`/equipment/${scannerTwo}`).set("Authorization", `Bearer ${cToken}`).expect(403);
    await http.post("/sessions").set("Authorization", `Bearer ${cToken}`).send({ equipmentId: scannerTwo }).expect(403);

    const dToken = await operatorInClinic(companyD, clinicId);
    const dList = await http.get("/equipment").set("Authorization", `Bearer ${dToken}`).expect(200);
    expect(dList.body.map((e: { name: string }) => e.name)).toEqual(["Shared-Room-CT"]);
    await http.get(`/equipment/${scannerOne}`).set("Authorization", `Bearer ${dToken}`).expect(403);
  });

  it("refuses an equipment-level grant naming another clinic's device, same as the unit-level check", async () => {
    const agreements = await http.get("/agreements").set("Authorization", `Bearer ${clinicAdminToken}`).expect(200);
    const agreementId = (agreements.body as { id: string }[])[0]!.id;

    const foreignEquipment = await prisma.equipment.create({
      data: {
        tenantId: otherClinicId,
        name: "Foreign Scanner",
        modality: "MRI",
        brand: "Siemens",
        model: "Magnetom Vida 3.0T",
        serialNumber: "FOREIGN-SN-000",
        roomLabel: "Foreign Room",
        installedAt: new Date("2025-01-15"),
        pikvmHost: "https://192.0.2.2",
        pikvmUser: "admin",
        pikvmPasswordCiphertext: "unused-in-this-test",
      },
    });

    const foreignGrant = await http
      .put(`/agreements/${agreementId}/scope`)
      .set("Authorization", `Bearer ${clinicAdminToken}`)
      .send({ unitIds: [], equipmentIds: [foreignEquipment.id] })
      .expect(403);
    expect(foreignGrant.body.code).toBe("FORBIDDEN");
  });

  /**
   * `GET /agreements/:id/scope-options` backs the scope modal's equipment picker -- see
   * `ListScopeOptionsHandler`'s own docstring for why it exists instead of a `clinicTenantId`
   * param on `GET /equipment`.
   */
  describe("GET /agreements/:id/scope-options", () => {
    it("lists the agreement's own clinic equipment, flagging direct and unit-inherited grants separately", async () => {
      const clinic2 = (await createTenant(prisma, `AgreeScopeOpts-${crypto.randomUUID()}`)).id;
      const clinic2Admin = await createLoggedInUser(app, { tenantId: clinic2, role: UserRole.CLINIC_ADMIN, emailPrefix: "agree-scopeopts-admin" });
      const company2 = (await createTenant(prisma, `AgreeScopeOptsCo-${crypto.randomUUID()}`, "OPERATOR_PROVIDER")).id;
      const company2Admin = (
        await createLoggedInUser(app, { tenantId: company2, role: UserRole.OPERATOR_ADMIN, emailPrefix: "agree-scopeopts-co-admin" })
      ).accessToken;

      const unitDirect = (
        await http
          .post("/units")
          .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
          .send(unitPayload(clinic2Admin.userId, { name: "Unidade Direta" }))
          .expect(201)
      ).body.id;
      const unitViaGrant = (
        await http
          .post("/units")
          .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
          .send(unitPayload(clinic2Admin.userId, { name: "Unidade Legada" }))
          .expect(201)
      ).body.id;
      const unitUngranted = (
        await http
          .post("/units")
          .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
          .send(unitPayload(clinic2Admin.userId, { name: "Unidade Sem Acesso" }))
          .expect(201)
      ).body.id;

      const eDirect = (
        await http
          .post("/equipment")
          .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
          .send(equipmentPayload({ name: "ScopeOpts-Direct", unitId: unitDirect }))
          .expect(201)
      ).body.id;
      const eViaUnit = (
        await http
          .post("/equipment")
          .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
          .send(equipmentPayload({ name: "ScopeOpts-ViaUnit", unitId: unitViaGrant }))
          .expect(201)
      ).body.id;
      const eUngranted = (
        await http
          .post("/equipment")
          .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
          .send(equipmentPayload({ name: "ScopeOpts-Ungranted", unitId: unitUngranted }))
          .expect(201)
      ).body.id;

      const proposed = await http
        .post("/agreements")
        .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
        .send({ operatorTenantId: company2 })
        .expect(201);
      await http.post(`/agreements/${proposed.body.id}/accept`).set("Authorization", `Bearer ${company2Admin}`).expect(201);
      // Deliberately mixes both grant shapes: `eDirect` by naming it, `unitViaGrant`'s equipment
      // by naming the unit -- exactly the "legacy row still live" state the real UI must handle.
      await http
        .put(`/agreements/${proposed.body.id}/scope`)
        .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
        .send({ unitIds: [unitViaGrant], equipmentIds: [eDirect] })
        .expect(200);

      const options = await http
        .get(`/agreements/${proposed.body.id}/scope-options`)
        .set("Authorization", `Bearer ${clinic2Admin.accessToken}`)
        .expect(200);
      const byName = new Map(
        (options.body as { id: string; name: string; unitId: string; granted: boolean; grantedViaUnit: boolean }[]).map((o) => [o.name, o])
      );

      expect(byName.get("ScopeOpts-Direct")).toMatchObject({ unitId: unitDirect, granted: true, grantedViaUnit: false });
      expect(byName.get("ScopeOpts-ViaUnit")).toMatchObject({ unitId: unitViaGrant, granted: false, grantedViaUnit: true });
      expect(byName.get("ScopeOpts-Ungranted")).toMatchObject({ id: eUngranted, unitId: unitUngranted, granted: false, grantedViaUnit: false });

      // The operator side cannot even read its own agreement's options -- scope is the clinic's
      // to see and set, same `assertScopeCanBeSetBy` rule `PUT :id/scope` enforces.
      const asOperator = await http.get(`/agreements/${proposed.body.id}/scope-options`).set("Authorization", `Bearer ${company2Admin}`).expect(403);
      expect(asOperator.body.code).toBe("FORBIDDEN");

      // Nor can a clinic with no part in this agreement at all.
      const outsider = await http.get(`/agreements/${proposed.body.id}/scope-options`).set("Authorization", `Bearer ${clinicAdminToken}`).expect(403);
      expect(outsider.body.code).toBe("FORBIDDEN");
    });
  });
});
