-- Adds the clinical identity of a piece of equipment (what kind of exam it performs, who
-- made it, which room it physically sits in) alongside the teleoperation-console columns
-- that were, until now, the only thing this table described.
--
-- Purely additive: one new enum type and nine nullable columns, no backfill. Unlike the
-- units migration -- which backfilled `equipment.unitId` because a correct default existed
-- ("this clinic's only unit") -- there is no correct default for a brand, a model, or a
-- serial number. Inventing one would put fabricated asset-tracking data into a table that
-- ANVISA calibration records are meant to be traceable against. Pre-existing rows therefore
-- keep NULLs here until someone edits them; every *new* row gets real values, enforced at
-- the API by CreateEquipmentRequestSchema rather than by a NOT NULL constraint this
-- migration cannot honestly add yet.

-- CreateEnum
CREATE TYPE "ExamModality" AS ENUM ('MRI', 'CT', 'ULTRASOUND');

-- AlterTable
ALTER TABLE "equipment" ADD COLUMN     "aeTitle" TEXT,
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "dicomIp" TEXT,
ADD COLUMN     "dicomPort" INTEGER,
ADD COLUMN     "installedAt" TIMESTAMP(3),
ADD COLUMN     "modality" "ExamModality",
ADD COLUMN     "model" TEXT,
ADD COLUMN     "roomLabel" TEXT,
ADD COLUMN     "serialNumber" TEXT;

-- `deactivatedAt` is deliberately NOT another `EquipmentStatus` member. `status` is a health
-- field that PiKvmHealthPoller rewrites every 10 seconds for every non-MAINTENANCE device,
-- so "an admin retired this scanner" expressed as a status would be reverted to ONLINE by
-- the next poll that reached the device. A separate nullable timestamp is also exactly how
-- `tenants.deactivatedAt` and `units.deactivatedAt` already work in this schema. Every
-- existing row is in service, so NULL (the column default) is the correct value for all of
-- them and no backfill is needed here either.
