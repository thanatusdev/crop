import { Injectable } from "@nestjs/common";
import { QueueStatus } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { QueueEntry } from "../domain/queue-entry.entity.js";
import type { CreateQueueEntryData, QueueRepositoryPort } from "../application/ports/queue-repository.port.js";

const WITH_TENANT = { equipment: { select: { tenantId: true } } } as const;

@Injectable()
export class PrismaQueueRepository implements QueueRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateQueueEntryData): Promise<QueueEntry> {
    const row = await this.prisma.$transaction(async (tx) => {
      const last = await tx.queueEntry.findFirst({
        where: { equipmentId: data.equipmentId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return tx.queueEntry.create({
        data: {
          equipmentId: data.equipmentId,
          patientFirstName: data.patientFirstName,
          scheduledAt: data.scheduledAt,
          position: (last?.position ?? 0) + 1,
        },
        include: WITH_TENANT,
      });
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<QueueEntry | null> {
    const row = await this.prisma.queueEntry.findUnique({ where: { id }, include: WITH_TENANT });
    return row ? this.toDomain(row) : null;
  }

  async listByEquipment(equipmentId: string): Promise<QueueEntry[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: { equipmentId },
      orderBy: { position: "asc" },
      include: WITH_TENANT,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async updateStatus(id: string, status: QueueStatus): Promise<void> {
    await this.prisma.queueEntry.update({ where: { id }, data: { status } });
  }

  private toDomain(row: {
    id: string;
    equipmentId: string;
    equipment: { tenantId: string };
    patientFirstName: string;
    position: number;
    status: string;
    scheduledAt: Date | null;
  }): QueueEntry {
    return new QueueEntry({
      id: row.id,
      tenantId: row.equipment.tenantId,
      equipmentId: row.equipmentId,
      patientFirstName: row.patientFirstName,
      position: row.position,
      status: row.status as QueueStatus,
      scheduledAt: row.scheduledAt,
    });
  }
}
