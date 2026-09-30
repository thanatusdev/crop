import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { planQueueReorder } from "../../../domain/queue-order.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { QueueUpdatedEvent } from "../../events/queue-updated.event.js";
import { ReorderQueueCommand } from "./reorder-queue.command.js";

const REORDER_ERROR_MESSAGE: Record<"INCLUDES_NON_WAITING" | "STALE_SET", string> = {
  INCLUDES_NON_WAITING:
    "One of these patients is no longer waiting (already in the room or their exam is finished) -- reload the queue.",
  STALE_SET: "This room's queue changed since you loaded it -- reload and try reordering again.",
};

@CommandHandler(ReorderQueueCommand)
export class ReorderQueueHandler implements ICommandHandler<ReorderQueueCommand, void> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: ReorderQueueCommand): Promise<void> {
    const equipment = await this.equipment.findById(command.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", command.equipmentId);
    // Same tenant-isolation shape as every other queue handler -- see
    // CreateQueueEntryHandler's own comment for the history of why this check exists at all.
    if (!equipment.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    const entries = await this.queue.listByEquipment(command.equipmentId);
    const plan = planQueueReorder(entries, command.orderedIds);

    if (!plan.ok) {
      throw new ConflictError(REORDER_ERROR_MESSAGE[plan.reason]);
    }

    // A confirm that resolves to the queue's current order (e.g. the nurse dragged a card
    // and then dragged it straight back) is a genuine no-op -- no audit row, no broadcast,
    // same "nothing actually happened" reasoning UpdatePreparationStatusHandler doesn't need
    // (every one of its transitions is a real state change by construction) but this command
    // does, since a full re-submitted ordering can trivially equal the one already stored.
    if (plan.noop) {
      return;
    }

    const previousOrder = entries
      .filter((entry) => command.orderedIds.includes(entry.id))
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.id);

    await this.queue.reorder(plan.assignments);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_REORDERED,
        resourceType: "QueueEntry",
        resourceId: command.equipmentId,
        // Ids only, never patientFirstName -- same PHI rule as every other queue audit row
        // (see CreateQueueEntryHandler's own comment).
        details: { equipmentId: command.equipmentId, previousOrder, newOrder: [...command.orderedIds] },
      })
    );

    this.eventBus.publish(new QueueUpdatedEvent(command.tenantId, command.equipmentId));
  }
}
