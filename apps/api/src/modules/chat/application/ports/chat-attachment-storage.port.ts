export const CHAT_ATTACHMENT_STORAGE = Symbol("CHAT_ATTACHMENT_STORAGE");

/**
 * Where a chat message's optional attachment file actually lives. Local disk for this MVP,
 * the identical scope decision `SnapshotStoragePort` already documents for session
 * snapshots -- swapping this for object storage later only ever touches
 * `ChatAttachmentStorageService`, never `SendExamMessageHandler` or the download route.
 */
export interface ChatAttachmentStoragePort {
  /** Returns a path relative to the storage root, suitable for storing in
   * `ExamMessage.attachmentPath`. Keyed by equipment first, not by message id, purely so a
   * human inspecting the storage root directly can see one room's attachments grouped
   * together -- the actual lookup always goes through the database row, never a directory
   * listing. */
  save(equipmentId: string, filename: string, data: Buffer): Promise<string>;
  read(relativePath: string): Promise<Buffer>;
}
