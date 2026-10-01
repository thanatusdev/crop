import type { QueueDocumentKind } from "@crop/shared";

/** The nurse's upload of one document (`POST /queue/:id/documents`) -- see
 * `UploadQueueDocumentHandler`, the only caller. `data` is the whole file in memory (Multer's
 * default `memoryStorage`, same as `SendExamMessageCommand.attachment.data` for chat), not a
 * stream -- fine at this app's scale, same reasoning as every other local-disk storage path
 * here. */
export class UploadQueueDocumentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly queueEntryId: string,
    public readonly kind: QueueDocumentKind,
    public readonly filename: string,
    public readonly mimeType: string,
    public readonly data: Buffer
  ) {}
}
