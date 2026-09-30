-- AlterTable
ALTER TABLE "equipment" ADD COLUMN     "unitId" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "operatorTenantId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "invitedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "clinicTenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_clinic_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clinicTenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_clinic_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "units_clinicTenantId_idx" ON "units"("clinicTenantId");

-- CreateIndex
CREATE INDEX "user_clinic_memberships_userId_idx" ON "user_clinic_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_clinic_memberships_userId_clinicTenantId_key" ON "user_clinic_memberships"("userId", "clinicTenantId");

-- CreateIndex
CREATE INDEX "equipment_unitId_idx" ON "equipment"("unitId");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_operatorTenantId_fkey" FOREIGN KEY ("operatorTenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_clinicTenantId_fkey" FOREIGN KEY ("clinicTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_clinic_memberships" ADD CONSTRAINT "user_clinic_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_clinic_memberships" ADD CONSTRAINT "user_clinic_memberships_clinicTenantId_fkey" FOREIGN KEY ("clinicTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every account that exists before this migration is already onboarded (it
-- logged in the old way, by an admin-typed temp password) -- activatedAt must NOT stay
-- null for these rows, or LoginHandler's new "account not yet activated" check would lock
-- every existing user out the moment this migration runs. New rows created from here on
-- start with activatedAt = NULL until the invitation flow sets it.
UPDATE "users" SET "activatedAt" = "createdAt" WHERE "activatedAt" IS NULL;

-- Backfill: one default unit per existing CLINIC tenant ("Unidade Principal"), and point
-- that tenant's existing equipment at it -- see schema.prisma's own comment on why
-- Equipment.unitId stays nullable rather than being backfilled-then-required in one step.
INSERT INTO "units" ("id", "clinicTenantId", "name", "createdAt")
SELECT gen_random_uuid(), "id", 'Unidade Principal', CURRENT_TIMESTAMP
FROM "tenants"
WHERE "type" = 'CLINIC';

UPDATE "equipment" e
SET "unitId" = u."id"
FROM "units" u
WHERE u."clinicTenantId" = e."tenantId" AND u."name" = 'Unidade Principal';

-- Backfill: one membership row per existing user whose home tenant is a CLINIC, so
-- "which clinics can this user reach" never has to special-case a pre-migration account
-- that only ever had a single tenantId and no membership rows at all.
INSERT INTO "user_clinic_memberships" ("id", "userId", "clinicTenantId", "createdAt")
SELECT gen_random_uuid(), u."id", u."tenantId", CURRENT_TIMESTAMP
FROM "users" u
JOIN "tenants" t ON t."id" = u."tenantId"
WHERE t."type" = 'CLINIC';
