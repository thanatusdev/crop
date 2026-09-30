import type { ExamMessageDto, MessageShortcutDto } from "@crop/shared";
import type { ExamMessage } from "../domain/exam-message.entity.js";
import type { MessageShortcut } from "../domain/message-shortcut.entity.js";

/** `authorName` is resolved by the caller and passed in, the same "stay a pure, synchronous
 * mapper" shape `toQueueEntryDto`/`toSessionDto` already follow. */
export function toExamMessageDto(message: ExamMessage, authorName: string | null): ExamMessageDto {
  return {
    id: message.id,
    equipmentId: message.equipmentId,
    queueEntryId: message.queueEntryId,
    authorUserId: message.authorUserId,
    authorName,
    body: message.body,
    // `path` deliberately not included -- see `ExamMessageAttachmentSchema`'s own docstring:
    // a client reaches the file through `messageId` + the download route, never the storage
    // key itself.
    attachment: message.attachment
      ? {
          filename: message.attachment.filename,
          mimeType: message.attachment.mimeType,
          sizeBytes: message.attachment.sizeBytes,
          messageId: message.id,
        }
      : null,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toMessageShortcutDto(shortcut: MessageShortcut): MessageShortcutDto {
  return {
    id: shortcut.id,
    code: shortcut.code,
    label: shortcut.label,
    body: shortcut.body,
    createdByUserId: shortcut.createdByUserId,
    createdAt: shortcut.createdAt.toISOString(),
  };
}
