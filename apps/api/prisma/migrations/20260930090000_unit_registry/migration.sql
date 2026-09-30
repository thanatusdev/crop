-- Adds the institutional/regulatory identity of a unit (establishment type, CNES, contact,
-- physical address, declared modalities, technical manager) alongside the five columns that
-- were, until now, the only thing this table described. Same shape of change as
-- equipment_clinical_identity: one new enum, one enum extended, a batch of nullable columns,
-- no backfill -- there is no honest default for a street address or a CNES code, and every
-- row that predates this feature (including every clinic's migration-backfilled "Unidade
-- Principal") simply keeps NULLs until someone edits it. New rows get real values via
-- CreateUnitRequestSchema, not a NOT NULL constraint this migration cannot honestly add yet.
--
-- Also adds a case-insensitive unique index on (clinicTenantId, name): Prisma's schema
-- language cannot express a functional index, so it is hand-written here, the same way
-- audit_append_only and one_active_session_per_equipment already hand-write what the schema
-- language can't say. Verified against every existing row before writing this: no two units
-- in the same clinic share a name (case-insensitively), so this applies cleanly.

-- CreateEnum
CREATE TYPE "EstablishmentType" AS ENUM ('LABORATORY', 'IMAGING_CENTER', 'HOSPITAL', 'CLINIC', 'URGENT_CARE', 'MOBILE_UNIT');

-- AlterEnum
-- `XRAY` is not usable as a default or cast within this same migration transaction (Postgres
-- forbids that for a value added by an earlier statement in an uncommitted transaction) --
-- nothing below needs to, so that restriction never bites here.
ALTER TYPE "ExamModality" ADD VALUE 'XRAY';

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "cnesCode" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "complement" TEXT,
ADD COLUMN     "declaredModalities" "ExamModality"[] NOT NULL DEFAULT ARRAY[]::"ExamModality"[],
ADD COLUMN     "district" TEXT,
ADD COLUMN     "establishmentType" "EstablishmentType",
ADD COLUMN     "number" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "street" TEXT,
ADD COLUMN     "technicalEmail" TEXT,
ADD COLUMN     "technicalManagerId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "zipCode" TEXT;

-- `declaredModalities`/`updatedAt` needed a DEFAULT above only to satisfy Postgres while
-- backfilling the three existing rows -- neither is declared with `@default` in
-- schema.prisma, because neither needs one going forward: Prisma Client always sends `[]`
-- for an omitted required list field on `.create()`, and `@updatedAt` fields are stamped by
-- Prisma Client itself on every write, not by the database. Dropping the DEFAULT here in the
-- same migration (rather than leaving it and letting `prisma migrate dev` discover the drift
-- and generate a second, undocumented migration to remove it -- which is what actually
-- happened while authoring this) keeps the column definitions matching the schema exactly.
ALTER TABLE "units" ALTER COLUMN "declaredModalities" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "units_technicalManagerId_idx" ON "units"("technicalManagerId");

-- CreateIndex
-- `lower(name)`, not `name`: two units named "Unidade Centro" and "unidade centro" in the
-- same clinic would confuse an operator exactly as much as an exact duplicate would.
CREATE UNIQUE INDEX "units_clinicTenantId_lower_name_key" ON "units"("clinicTenantId", lower("name"));

-- AddForeignKey
-- ON DELETE SET NULL, not RESTRICT: a technical manager's account being removed (locked
-- accounts aren't deleted, but nothing rules out a future real delete path) must not block
-- or destroy the unit that pointed to them -- the unit just goes back to having no assigned
-- manager, the same nullable state a unit predating this feature is already in.
ALTER TABLE "units" ADD CONSTRAINT "units_technicalManagerId_fkey" FOREIGN KEY ("technicalManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
