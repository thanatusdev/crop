-- AlterTable
ALTER TABLE "exam_messages" ADD COLUMN     "attachmentFilename" TEXT,
ADD COLUMN     "attachmentMimeType" TEXT,
ADD COLUMN     "attachmentPath" TEXT,
ADD COLUMN     "attachmentSizeBytes" INTEGER;
