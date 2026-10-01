/**
 * The one file-type allow-list this app enforces anywhere a human can upload a file --
 * the exam-support chat's attachment (`ChatController`) and the nurse's exam-order upload
 * (`QueueController`). Images and one document type: a photo of a wristband/requisition, or
 * a signed PDF. Not an open allow-anything upload -- neither storage directory
 * (`ChatAttachmentStorageService`/`QueueDocumentStorageService`) has virus scanning or
 * content sniffing behind it, so the allow-list is enforced by declared mime type up front
 * rather than trusting whatever a browser happened to send.
 *
 * One shared constant, not two independent copies that happen to agree today -- this used
 * to be a hand-duplicated list between `ChatController` and `ExamChat.tsx`, each commenting
 * that the other had to be kept in sync by hand. Adding a third copy for queue documents is
 * where that stopped being tenable. If chat and documents ever need genuinely different
 * allow-lists, split this back into two named exports then -- there is no requirement they
 * stay equal forever, only that nothing today has a reason to diverge.
 *
 * Deliberately excludes DICOM: browsers do not report a reliable mime type for `.dcm`
 * (`application/octet-stream` or nothing at all), so a mime-based allow-list cannot gate it,
 * and nothing in this app can render DICOM once stored -- see docs/architecture.md's
 * "What's intentionally not built".
 */
export const ALLOWED_DOCUMENT_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
