import type { QueueEntryDocumentDto } from "@crop/shared";
import { QueueEntryDocument } from "../domain/queue-entry-document.entity.js";

/** `uploadedByName` is resolved by the caller (`QueueController`, via the same
 * `USER_REPOSITORY.summarizeDisplayNames` batch `resolveDetailsUpdatedByNames` already
 * uses) -- same "stay a pure, synchronous mapper" rule `toQueueEntryDto` itself follows. */
export function toQueueEntryDocumentDto(document: QueueEntryDocument, uploadedByName: string | null = null): QueueEntryDocumentDto {
  return {
    id: document.id,
    kind: document.kind,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    uploadedAt: document.uploadedAt.toISOString(),
    uploadedByName,
  };
}
