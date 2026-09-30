-- CreateEnum
CREATE TYPE "PatientSex" AS ENUM ('FEMALE', 'MALE', 'OTHER');

-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "contrastRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "examDescription" TEXT,
ADD COLUMN     "patientSex" "PatientSex",
ADD COLUMN     "patientWeightKg" INTEGER,
ADD COLUMN     "preparationNotes" TEXT;

-- CreateIndex
CREATE INDEX "queue_entries_equipmentId_position_idx" ON "queue_entries"("equipmentId", "position");
