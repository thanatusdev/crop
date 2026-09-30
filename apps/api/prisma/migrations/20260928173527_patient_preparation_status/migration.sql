-- CreateEnum
CREATE TYPE "PreparationStatus" AS ENUM ('NOT_STARTED', 'POSITIONED', 'INJECTED', 'RELEASED');

-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "injectedAt" TIMESTAMP(3),
ADD COLUMN     "positionedAt" TIMESTAMP(3),
ADD COLUMN     "preparationStatus" "PreparationStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "releasedAt" TIMESTAMP(3);
