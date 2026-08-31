import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { QueueEntry } from "../../../domain/queue-entry.entity.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { CreateQueueEntryCommand } from "./create-queue-entry.command.js";

@CommandHandler(CreateQueueEntryCommand)
export class CreateQueueEntryHandler implements ICommandHandler<CreateQueueEntryCommand, QueueEntry> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: CreateQueueEntryCommand): Promise<QueueEntry> {
    const equipment = await this.equipment.findById(command.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", command.equipmentId);
    // Multi-tenant isolation, enforced here rather than trusted to the caller -- mirrors
    // GetEquipmentHandler/GetSessionHandler. QueueController previously had no such check at
    // all, on any of its three routes: any authenticated user, any tenant, any role, could
    // add, list, or transition another tenant's patient queue by equipmentId/queueEntryId
    // alone. See docs/architecture.md.
    if (!equipment.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    const entry = await this.queue.create({
      equipmentId: command.equipmentId,
      patientFirstName: command.patientFirstName,
      scheduledAt: command.scheduledAt,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_ENTRY_CREATED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        // Deliberately no patientFirstName here -- same reasoning as PrintTextHandler: the
        // audit trail should prove the action happened without duplicating patient-
        // identifying data into a second table.
        details: { equipmentId: entry.equipmentId },
      })
    );

    return entry;
  }
}
