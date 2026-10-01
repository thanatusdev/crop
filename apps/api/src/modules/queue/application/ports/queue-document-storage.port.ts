export const QUEUE_DOCUMENT_STORAGE = Symbol("QUEUE_DOCUMENT_STORAGE");

/** Mirrors `ChatAttachmentStoragePort` exactly -- same two-method shape, same reasoning
 * (see `QueueDocumentStorageService`'s own docstring). */
export interface QueueDocumentStoragePort {
  save(queueEntryId: string, filename: string, data: Buffer): Promise<string>;
  read(relativePath: string): Promise<Buffer>;
  /** Removal is a real, separate capability here (chat attachments have no equivalent --
   * nothing ever deletes a chat message) -- see `RemoveQueueDocumentHandler`, the only
   * caller: a mis-uploaded document is PHI, and "removed" has to mean the bytes are gone,
   * not just the DB row. */
  delete(relativePath: string): Promise<void>;
}
