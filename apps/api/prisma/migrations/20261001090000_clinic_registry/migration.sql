-- Adds a clinic's institutional identity (CNPJ, contact, registered address) and its
-- responsible manager, alongside the six columns that were, until now, the only thing this
-- table described. Same shape of change as the unit_registry and equipment_clinical_identity
-- migrations before it: nullable columns, no backfill -- there is no honest CNPJ or address
-- to invent for a pre-existing clinic, `PLATFORM`/`OPERATOR_PROVIDER` tenants never have
-- either at all, and the constraint stopping a NEW clinic from joining that null set lives
-- in CreateTenantRequestSchema (a `.superRefine` requiring these fields when
-- `type === CLINIC`), not in a NOT NULL constraint this migration cannot honestly add yet.
--
-- `cnpj` is unique -- Postgres treats multiple NULLs as distinct for a unique index, so
-- every pre-existing tenant (all NULL) coexists fine, and this is the identity the
-- matriz/filial derivation (packages/shared/src/cnpj.ts) and clinic-uniqueness both rest on.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "city" TEXT,
ADD COLUMN     "cnpj" TEXT,
ADD COLUMN     "complement" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "institutionalEmail" TEXT,
ADD COLUMN     "number" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "responsibleManagerId" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "street" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "zipCode" TEXT;

-- `updatedAt` needed a DEFAULT above only to satisfy Postgres while backfilling existing
-- rows -- it isn't declared with `@default` in schema.prisma, because `@updatedAt` fields
-- are stamped by Prisma Client on every write, not by the database. Dropped here in the
-- same migration rather than letting `prisma migrate dev` discover the drift later (see the
-- unit_registry migration's own note -- this is that exact lesson applied up front).
ALTER TABLE "tenants" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_cnpj_key" ON "tenants"("cnpj");

-- CreateIndex
CREATE INDEX "tenants_responsibleManagerId_idx" ON "tenants"("responsibleManagerId");

-- AddForeignKey
-- ON DELETE SET NULL, not RESTRICT -- same reasoning as units.technicalManagerId's own FK:
-- the responsible manager's account being removed must not block or destroy the clinic that
-- named them, it just goes back to having no assigned manager.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_responsibleManagerId_fkey" FOREIGN KEY ("responsibleManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
