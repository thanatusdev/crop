-- CreateEnum
CREATE TYPE "AllergyStatus" AS ENUM ('NEGATED', 'PRESENT');

-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "allergyNotes" TEXT,
ADD COLUMN     "allergyStatus" "AllergyStatus",
ADD COLUMN     "contrastVolumeMl" INTEGER,
ADD COLUMN     "creatinineMgDl" DOUBLE PRECISION,
ADD COLUMN     "detailsUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "detailsUpdatedByUserId" TEXT,
ADD COLUMN     "fastingConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fastingHours" INTEGER;
