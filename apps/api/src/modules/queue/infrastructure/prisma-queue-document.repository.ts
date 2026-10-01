import { Injectable } from "@nestjs/common";
import type { QueueDocumentKind } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { QueueEntryDocument } from "../domain/queue-entry-document.entity.js";
import type {
  CreateQueueDocumentData,
  QueueDocumentRepositoryPort,
} from "../application/ports/queue-document-repository.port.js";

/** `queueEntry.equipment.tenantId` -- the same two-hop "derive it, don't store it
 * redundantly" choice `PrismaExamMessageRepository` makes for `ExamMessage.tenantId`, just
 * one relation deeper (document -> queueEntry -> equipment) since this table has no direct
 * `equipmentId` column of its own. */
const WITH_TENANT_AND_EQUIPMENT = {
  queueEntry: { select: { equipmentId: true, equipment: { select: { tenantId: true } } } },
} as const;

type RowWithTenant = {
  id: string;
  queueEntryId: string;
  // Prisma's own generated enum, structurally identical to but nominally distinct from
  // `@crop/shared`'s `QueueDocumentKind` -- the same cast `PrismaQueueRepository.toDomain`
  // already needs for `status`/`preparationStatus`/etc.
  kind: string;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  uploadedAt: Date;
  queueEntry: { equipmentId: string; equipment: { tenantId: string } };
};

@Injectable()
export class PrismaQueueDocumentRepository implements QueueDocumentRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateQueueDocumentData): Promise<QueueEntryDocument> {
    const row = await this.prisma.queueEntryDocument.create({
      data: {
        queueEntryId: data.queueEntryId,
        kind: data.kind,
        path: data.path,
        filename: data.filename,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        uploadedByUserId: data.uploadedByUserId,
      },
      include: WITH_TENANT_AND_EQUIPMENT,
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<QueueEntryDocument | null> {
    const row = await this.prisma.queueEntryDocument.findUnique({ where: { id }, include: WITH_TENANT_AND_EQUIPMENT });
    return row ? this.toDomain(row) : null;
  }

  async listByQueueEntry(queueEntryId: string): Promise<QueueEntryDocument[]> {
    const rows = await this.prisma.queueEntryDocument.findMany({
      where: { queueEntryId },
      orderBy: { uploadedAt: "asc" },
      include: WITH_TENANT_AND_EQUIPMENT,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async listByQueueEntries(queueEntryIds: readonly string[]): Promise<QueueEntryDocument[]> {
    if (queueEntryIds.length === 0) return [];
    const rows = await this.prisma.queueEntryDocument.findMany({
      where: { queueEntryId: { in: [...queueEntryIds] } },
      orderBy: { uploadedAt: "asc" },
      include: WITH_TENANT_AND_EQUIPMENT,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async delete(id: string): Promise<void> {
    await this.prisma.queueEntryDocument.delete({ where: { id } });
  }

  private toDomain(row: RowWithTenant): QueueEntryDocument {
    return new QueueEntryDocument({
      id: row.id,
      queueEntryId: row.queueEntryId,
      tenantId: row.queueEntry.equipment.tenantId,
      equipmentId: row.queueEntry.equipmentId,
      kind: row.kind as QueueDocumentKind,
      path: row.path,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      uploadedByUserId: row.uploadedByUserId,
      uploadedAt: row.uploadedAt,
    });
  }
}
