-- Replaces `Tenant.operatorTenantId` with a real many-to-many contract between a clinic and an
-- operating company, carrying an accept/reject handshake and a per-unit/per-equipment scope.
--
-- The old column could only express "this clinic has at most one operating company", had no
-- handshake (a PLATFORM_ADMIN set it unilaterally), and had no way to say a company may drive
-- some of the clinic's scanners but not others. See the OperatorAgreement model's own comment.
--
-- Access-preserving by construction: every existing link becomes an ACTIVE agreement, and every
-- such clinic's units become explicit grants, so no operator loses reach the moment this runs.
-- The alternative -- treating "no scope rows" as "everything" -- would have made the dangerous
-- reading the permanent default, so prior access is expressed as real data instead.

CREATE TYPE "AgreementStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED');

CREATE TABLE "operator_agreements" (
    "id" TEXT NOT NULL,
    "clinicTenantId" TEXT NOT NULL,
    "operatorTenantId" TEXT NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'PENDING',
    "proposedByTenantId" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "respondedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_agreements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operator_agreement_scopes" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "unitId" TEXT,
    "equipmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "operator_agreement_scopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_agreements_clinicTenantId_operatorTenantId_key"
  ON "operator_agreements"("clinicTenantId", "operatorTenantId");
CREATE INDEX "operator_agreements_operatorTenantId_status_idx" ON "operator_agreements"("operatorTenantId", "status");
CREATE INDEX "operator_agreements_clinicTenantId_status_idx" ON "operator_agreements"("clinicTenantId", "status");

-- NULLs are distinct in a Postgres unique index, so the unit index never collides with the
-- equipment rows (whose unitId is NULL) or vice versa -- each stops double-granting its own kind.
CREATE UNIQUE INDEX "operator_agreement_scopes_agreementId_unitId_key" ON "operator_agreement_scopes"("agreementId", "unitId");
CREATE UNIQUE INDEX "operator_agreement_scopes_agreementId_equipmentId_key" ON "operator_agreement_scopes"("agreementId", "equipmentId");
CREATE INDEX "operator_agreement_scopes_agreementId_idx" ON "operator_agreement_scopes"("agreementId");

ALTER TABLE "operator_agreements" ADD CONSTRAINT "operator_agreements_clinicTenantId_fkey"
  FOREIGN KEY ("clinicTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_agreements" ADD CONSTRAINT "operator_agreements_operatorTenantId_fkey"
  FOREIGN KEY ("operatorTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_agreement_scopes" ADD CONSTRAINT "operator_agreement_scopes_agreementId_fkey"
  FOREIGN KEY ("agreementId") REFERENCES "operator_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "operator_agreement_scopes" ADD CONSTRAINT "operator_agreement_scopes_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "operator_agreement_scopes" ADD CONSTRAINT "operator_agreement_scopes_equipmentId_fkey"
  FOREIGN KEY ("equipmentId") REFERENCES "equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of unitId/equipmentId, enforced in the database and not only in Zod: migrations
-- and admin scripts write here too, and a row granting "neither" would silently grant nothing
-- while a row granting "both" would have two contradictory meanings.
ALTER TABLE "operator_agreement_scopes" ADD CONSTRAINT "operator_agreement_scopes_exactly_one_target"
  CHECK (("unitId" IS NOT NULL AND "equipmentId" IS NULL) OR ("unitId" IS NULL AND "equipmentId" IS NOT NULL));

-- 1. Every existing clinic -> operator link becomes an ACTIVE agreement. `proposedByTenantId`
--    is the clinic: the link was set by a platform admin on the clinic's record, and attributing
--    it to the operating company would assert a proposal that never happened. Actor columns stay
--    NULL, which is the same "no human admin acting" convention audit rows already use -- no
--    invented `respondedByUserId`.
INSERT INTO "operator_agreements" ("id", "clinicTenantId", "operatorTenantId", "status", "proposedByTenantId", "respondedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", c."operatorTenantId", 'ACTIVE', c."id", now(), now(), now()
FROM "tenants" c
WHERE c."type" = 'CLINIC' AND c."operatorTenantId" IS NOT NULL;

-- 2. Preserve prior reach: the old link granted the operator everything in the clinic, so grant
--    every one of that clinic's units. Unit-level (not equipment-level) deliberately, so
--    equipment the clinic installs into an already-granted room stays covered -- which is what
--    "the operator runs this clinic" meant before this migration.
INSERT INTO "operator_agreement_scopes" ("id", "agreementId", "unitId", "createdAt")
SELECT gen_random_uuid(), a."id", u."id", now()
FROM "operator_agreements" a
JOIN "units" u ON u."clinicTenantId" = a."clinicTenantId";

-- 3. Equipment that belongs to no unit (`unitId IS NULL` -- legal, see the Equipment model) is
--    unreachable through a unit grant, so it needs its own row. Missing this would have silently
--    revoked access to exactly those devices.
INSERT INTO "operator_agreement_scopes" ("id", "agreementId", "equipmentId", "createdAt")
SELECT gen_random_uuid(), a."id", e."id", now()
FROM "operator_agreements" a
JOIN "equipment" e ON e."tenantId" = a."clinicTenantId" AND e."unitId" IS NULL;

-- 4. Assert the conversion actually preserved every link before dropping the column, rather than
--    trusting the INSERT to have matched. Once the column is gone this is unrecoverable, so it is
--    checked while the evidence still exists.
DO $$
DECLARE links integer; agreements integer;
BEGIN
  SELECT count(*) INTO links FROM "tenants" WHERE "type" = 'CLINIC' AND "operatorTenantId" IS NOT NULL;
  SELECT count(*) INTO agreements FROM "operator_agreements" WHERE "status" = 'ACTIVE';
  IF links <> agreements THEN
    RAISE EXCEPTION 'operator_agreements: % operator link(s) but % ACTIVE agreement(s) -- refusing to drop the column', links, agreements;
  END IF;
END $$;

-- 5. An ACTIVE agreement that grants nothing would silently strip an operator of access they had
--    a moment ago. Only checked for clinics that actually have something to grant: a clinic with
--    no units and no unit-less equipment had nothing reachable before this migration either.
DO $$
DECLARE empty_scoped integer;
BEGIN
  SELECT count(*) INTO empty_scoped
  FROM "operator_agreements" a
  WHERE NOT EXISTS (SELECT 1 FROM "operator_agreement_scopes" s WHERE s."agreementId" = a."id")
    AND (EXISTS (SELECT 1 FROM "units" u WHERE u."clinicTenantId" = a."clinicTenantId")
      OR EXISTS (SELECT 1 FROM "equipment" e WHERE e."tenantId" = a."clinicTenantId"));
  IF empty_scoped > 0 THEN
    RAISE EXCEPTION 'operator_agreements: % converted agreement(s) ended up with no scope despite the clinic having units/equipment', empty_scoped;
  END IF;
END $$;

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_operatorTenantId_fkey";
DROP INDEX IF EXISTS "tenants_operatorTenantId_idx";
ALTER TABLE "tenants" DROP COLUMN "operatorTenantId";
