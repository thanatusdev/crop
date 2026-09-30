import type { ExamMessage } from "../../domain/exam-message.entity.js";

export const EXAM_MESSAGE_REPOSITORY = Symbol("EXAM_MESSAGE_REPOSITORY");

export interface CreateExamMessageData {
  equipmentId: string;
  queueEntryId: string | null;
  authorUserId: string;
  body: string;
  attachment: { path: string; filename: string; mimeType: string; sizeBytes: number } | null;
}

export interface ListExamMessagesOptions {
  /** `[gte, lt)` UTC bounds for one clinical day (see `clinicDayBounds`) -- omit for the
   * pre-day-scoping behaviour ("this room's whole history"), still used by
   * `SendExamMessageHandler`'s own current-patient lookup, which has no day to scope by. */
  createdBetween?: { gte: Date; lt: Date };
  limit?: number;
}

export interface ExamMessageRepositoryPort {
  create(data: CreateExamMessageData): Promise<ExamMessage>;
  findById(id: string): Promise<ExamMessage | null>;
  /** Newest-last (chat reading order), optionally capped and/or day-bounded -- see
   * `ListExamMessagesHandler` for the default cap and how `createdBetween` is derived. */
  listByEquipment(equipmentId: string, options?: ListExamMessagesOptions): Promise<ExamMessage[]>;
}
