import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { ExamMessage } from "../domain/exam-message.entity.js";
import type {
  CreateExamMessageData,
  ExamMessageRepositoryPort,
  ListExamMessagesOptions,
} from "../application/ports/exam-message-repository.port.js";

const WITH_TENANT = { equipment: { select: { tenantId: true } } } as const;

/** Read through the `equipment` relation for `tenantId`, the same "derive it, don't store
 * it redundantly" choice `PrismaQueueRepository` already made for `QueueEntry`. */
@Injectable()
export class PrismaExamMessageRepository implements ExamMessageRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateExamMessageData): Promise<ExamMessage> {
    const row = await this.prisma.examMessage.create({
      data: {
        equipmentId: data.equipmentId,
        queueEntryId: data.queueEntryId ?? undefined,
        authorUserId: data.authorUserId,
        body: data.body,
        attachmentPath: data.attachment?.path ?? undefined,
        attachmentFilename: data.attachment?.filename ?? undefined,
        attachmentMimeType: data.attachment?.mimeType ?? undefined,
        attachmentSizeBytes: data.attachment?.sizeBytes ?? undefined,
      },
      include: WITH_TENANT,
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<ExamMessage | null> {
    const row = await this.prisma.examMessage.findUnique({ where: { id }, include: WITH_TENANT });
    return row ? this.toDomain(row) : null;
  }

  /** Default cap of 200: enough for a full shift's worth of chat in one exam room without
   * an unbounded query -- pagination is a real, separate follow-up if a room's transcript
   * ever grows past that in practice. Oldest-first (chat reading order), taken from the
   * *newest* `limit` rows -- see the two-step query below. */
  async listByEquipment(equipmentId: string, options: ListExamMessagesOptions = {}): Promise<ExamMessage[]> {
    const { createdBetween, limit = 200 } = options;
    const rows = await this.prisma.examMessage.findMany({
      where: { equipmentId, ...(createdBetween ? { createdAt: { gte: createdBetween.gte, lt: createdBetween.lt } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: WITH_TENANT,
    });
    return rows.reverse().map((row) => this.toDomain(row));
  }

  private toDomain(row: {
    id: string;
    equipmentId: string;
    equipment: { tenantId: string };
    queueEntryId: string | null;
    authorUserId: string;
    body: string;
    attachmentPath: string | null;
    attachmentFilename: string | null;
    attachmentMimeType: string | null;
    attachmentSizeBytes: number | null;
    createdAt: Date;
  }): ExamMessage {
    return new ExamMessage({
      id: row.id,
      tenantId: row.equipment.tenantId,
      equipmentId: row.equipmentId,
      queueEntryId: row.queueEntryId,
      authorUserId: row.authorUserId,
      body: row.body,
      attachment:
        row.attachmentPath && row.attachmentFilename && row.attachmentMimeType && row.attachmentSizeBytes != null
          ? {
              path: row.attachmentPath,
              filename: row.attachmentFilename,
              mimeType: row.attachmentMimeType,
              sizeBytes: row.attachmentSizeBytes,
            }
          : null,
      createdAt: row.createdAt,
    });
  }
}
