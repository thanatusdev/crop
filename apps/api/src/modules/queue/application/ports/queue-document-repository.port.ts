import type { QueueDocumentKind } from "@crop/shared";
import { QueueEntryDocument } from "../../domain/queue-entry-document.entity.js";

export const QUEUE_DOCUMENT_REPOSITORY = Symbol("QUEUE_DOCUMENT_REPOSITORY");

export interface CreateQueueDocumentData {
  queueEntryId: string;
  kind: QueueDocumentKind;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: string;
}

export interface QueueDocumentRepositoryPort {
  create(data: CreateQueueDocumentData): Promise<QueueEntryDocument>;
  findById(id: string): Promise<QueueEntryDocument | null>;
  /** Oldest-first -- the order the nurse uploaded them in, not grouped by kind. */
  listByQueueEntry(queueEntryId: string): Promise<QueueEntryDocument[]>;
  /** Same batched shape as `UserRepositoryPort.summarizeDisplayNames` -- `toQueueEntryDto`
   * hydrates every entry's `documents` in one query per page load, not one per entry. */
  listByQueueEntries(queueEntryIds: readonly string[]): Promise<QueueEntryDocument[]>;
  /** Row only -- the caller (`RemoveQueueDocumentHandler`) deletes this row *before* the
   * underlying bytes, not after: if the storage delete then fails, the result is an orphaned
   * file nothing can ever reach again (the download route resolves through this row, which
   * is already gone), not a dangling row pointing at bytes that no longer exist. The former
   * is a disk-space leak; the latter is a 500 on every future read attempt. */
  delete(id: string): Promise<void>;
}
