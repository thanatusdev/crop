-- CreateEnum
CREATE TYPE "QueueDocumentKind" AS ENUM ('PEDIDO_MEDICO', 'LAUDO_ANTERIOR', 'OUTRO');

-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "anticoagulantUse" BOOLEAN,
ADD COLUMN     "metforminUse" BOOLEAN;

-- CreateTable
CREATE TABLE "queue_entry_documents" (
    "id" TEXT NOT NULL,
    "queueEntryId" TEXT NOT NULL,
    "kind" "QueueDocumentKind" NOT NULL DEFAULT 'PEDIDO_MEDICO',
    "path" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_entry_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "queue_entry_documents_queueEntryId_idx" ON "queue_entry_documents"("queueEntryId");

-- AddForeignKey
ALTER TABLE "queue_entry_documents" ADD CONSTRAINT "queue_entry_documents_queueEntryId_fkey" FOREIGN KEY ("queueEntryId") REFERENCES "queue_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
