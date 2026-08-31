import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { EquipmentStatusChangedEvent } from "../../events/equipment-status-changed.event.js";
import { UpdateEquipmentStatusCommand } from "./update-equipment-status.command.js";

@CommandHandler(UpdateEquipmentStatusCommand)
export class UpdateEquipmentStatusHandler implements ICommandHandler<UpdateEquipmentStatusCommand, void> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: UpdateEquipmentStatusCommand): Promise<void> {
    // `PiKvmHealthPoller` dispatches this every 10 seconds for every piece of equipment,
    // unconditionally -- auditing every dispatch would flood the audit trail with a new row
    // per device every 10 seconds, forever, drowning out every actually-meaningful event.
    // Only a genuine transition is worth recording, so this reads current status first and
    // no-ops (skipping the write, the audit, AND the broadcast below) if nothing changed --
    // the same guard now also prevents a live-push storm every 10s for steady-state equipment.
    const current = await this.equipment.findById(command.equipmentId);
    if (!current || current.status === command.status) return;

    await this.equipment.updateStatus(command.equipmentId, command.status);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: current.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.EQUIPMENT_UPDATED,
        resourceType: "Equipment",
        resourceId: current.id,
        details: { previousStatus: current.status, newStatus: command.status },
      })
    );

    this.eventBus.publish(new EquipmentStatusChangedEvent(current.tenantId, current.id, command.status));
  }
}
