import { Injectable } from "@nestjs/common";
import { PreparationStatus, QueueStatus } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { QueueEntry } from "../domain/queue-entry.entity.js";
import type { QueueReorderAssignment } from "../domain/queue-order.js";
import type { CreateQueueEntryData, DayBounds, QueueRepositoryPort, UpdateQueueEntryDetailsData } from "../application/ports/queue-repository.port.js";

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

  /** `dayBounds` filters on `scheduledAt` when it's set, falling back to `createdAt` for
   * the rows that have none -- an entry added today with no explicit scheduled time still
   * belongs in today's view rather than silently vanishing from it. Omitting `dayBounds`
   * entirely (every pre-existing caller) skips this `OR` altogether, exactly the unscoped
   * query this method always ran before day-scoping existed -- see `DayBounds`'s own
   * docstring. */
  async listByEquipment(equipmentId: string, dayBounds?: DayBounds): Promise<QueueEntry[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: {
        equipmentId,
        ...(dayBounds && {
          OR: [
            { scheduledAt: { gte: dayBounds.gte, lt: dayBounds.lt } },
            { scheduledAt: null, createdAt: { gte: dayBounds.gte, lt: dayBounds.lt } },
          ],
        }),
      },
      orderBy: { position: "asc" },
      include: WITH_TENANT,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async updateStatus(id: string, status: QueueStatus): Promise<void> {
    await this.prisma.queueEntry.update({ where: { id }, data: { status } });
  }

  /** One statement, enum + its matching timestamp column together -- see
   * QueueRepositoryPort.updatePreparation's docstring for why they must never diverge.
   * NOT_STARTED never reaches here (see QueueEntry.assertCanTransitionPreparationTo), so
   * the switch has no branch for it and TypeScript enforces that every other member does. */
  async updatePreparation(id: string, status: PreparationStatus, occurredAt: Date): Promise<void> {
    switch (status) {
      case PreparationStatus.POSITIONED:
        await this.prisma.queueEntry.update({ where: { id }, data: { preparationStatus: status, positionedAt: occurredAt } });
        return;
      case PreparationStatus.INJECTED:
        await this.prisma.queueEntry.update({ where: { id }, data: { preparationStatus: status, injectedAt: occurredAt } });
        return;
      case PreparationStatus.RELEASED:
        await this.prisma.queueEntry.update({ where: { id }, data: { preparationStatus: status, releasedAt: occurredAt } });
        return;
      case PreparationStatus.NOT_STARTED:
        throw new Error("NOT_STARTED is never a target of updatePreparation -- see QueueEntry's own transition guard");
    }
  }

  /** One transaction for the whole set of assignments -- planQueueReorder guarantees every
   * id here is a WAITING entry of the same equipment being reassigned into a position slot
   * another WAITING entry of that same set already occupied, so this never needs to touch,
   * or even know about, any entry outside the ones ReorderQueueHandler already validated. */
  async reorder(assignments: readonly QueueReorderAssignment[]): Promise<void> {
    await this.prisma.$transaction(
      assignments.map((assignment) =>
        this.prisma.queueEntry.update({ where: { id: assignment.id }, data: { position: assignment.position } })
      )
    );
  }

  async updateDetails(id: string, data: UpdateQueueEntryDetailsData): Promise<void> {
    await this.prisma.queueEntry.update({ where: { id }, data });
  }

  async updateTeleoperationNotes(id: string, teleoperationNotes: string): Promise<void> {
    await this.prisma.queueEntry.update({ where: { id }, data: { teleoperationNotes } });
  }

  private toDomain(row: {
    id: string;
    equipmentId: string;
    equipment: { tenantId: string };
    patientFirstName: string;
    position: number;
    status: string;
    scheduledAt: Date | null;
    preparationStatus: string;
    positionedAt: Date | null;
    injectedAt: Date | null;
    releasedAt: Date | null;
    examDescription: string | null;
    contrastRequired: boolean;
    patientSex: string | null;
    patientWeightKg: number | null;
    preparationNotes: string | null;
    fastingConfirmed: boolean;
    fastingHours: number | null;
    creatinineMgDl: number | null;
    allergyStatus: string | null;
    allergyNotes: string | null;
    contrastVolumeMl: number | null;
    detailsUpdatedAt: Date | null;
    detailsUpdatedByUserId: string | null;
    teleoperationNotes: string | null;
  }): QueueEntry {
    return new QueueEntry({
      id: row.id,
      tenantId: row.equipment.tenantId,
      equipmentId: row.equipmentId,
      patientFirstName: row.patientFirstName,
      position: row.position,
      status: row.status as QueueStatus,
      scheduledAt: row.scheduledAt,
      preparationStatus: row.preparationStatus as PreparationStatus,
      positionedAt: row.positionedAt,
      injectedAt: row.injectedAt,
      releasedAt: row.releasedAt,
      examDescription: row.examDescription,
      contrastRequired: row.contrastRequired,
      patientSex: row.patientSex as QueueEntry["patientSex"],
      patientWeightKg: row.patientWeightKg,
      preparationNotes: row.preparationNotes,
      fastingConfirmed: row.fastingConfirmed,
      fastingHours: row.fastingHours,
      creatinineMgDl: row.creatinineMgDl,
      allergyStatus: row.allergyStatus as QueueEntry["allergyStatus"],
      allergyNotes: row.allergyNotes,
      contrastVolumeMl: row.contrastVolumeMl,
      detailsUpdatedAt: row.detailsUpdatedAt,
      detailsUpdatedByUserId: row.detailsUpdatedByUserId,
      teleoperationNotes: row.teleoperationNotes,
    });
  }
}
