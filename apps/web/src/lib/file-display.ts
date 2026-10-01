/**
 * Human-readable file size for an attachment/document chip -- shared by `ExamChat` (chat
 * attachments) and `NursingPage`/`ExamPage` (exam-order documents), extracted out of
 * `ExamChat.tsx` once a second consumer needed the identical formatting rather than a copy.
 */
export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
