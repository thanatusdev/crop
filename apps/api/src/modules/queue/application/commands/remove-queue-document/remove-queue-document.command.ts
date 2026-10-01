/** The nurse's removal of one document (`POST /queue/:id/documents/:docId/remove`) -- see
 * `RemoveQueueDocumentHandler`, the only caller. Takes both ids, not just `documentId`: the
 * handler checks the document actually belongs to this exact queue entry (not just this
 * tenant) before touching anything, so a `docId` that is real but for a *different* queue
 * entry fails the same way a nonexistent one does, rather than silently succeeding against
 * the wrong URL. */
export class RemoveQueueDocumentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly queueEntryId: string,
    public readonly documentId: string
  ) {}
}
