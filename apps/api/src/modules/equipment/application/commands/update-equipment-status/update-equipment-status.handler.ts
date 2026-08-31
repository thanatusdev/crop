import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { UpdateEquipmentStatusCommand } from "./update-equipment-status.command.js";

@CommandHandler(UpdateEquipmentStatusCommand)
export class UpdateEquipmentStatusHandler implements ICommandHandler<UpdateEquipmentStatusCommand, void> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UpdateEquipmentStatusCommand): Promise<void> {
    // `PiKvmHealthPoller` dispatches this every 10 seconds for every piece of equipment,
    // unconditionally -- auditing every dispatch would flood the audit trail with a new row
    // per device every 10 seconds, forever, drowning out every actually-meaningful event.
    // Only a genuine transition is worth recording, so this reads current status first and
    // no-ops (skipping both the write and the audit) if nothing actually changed.
    const current = await this.equipment.findById(command.equipmentId);
    if (!current || current.status === command.status) return;

    await this.equipment.updateStatus(command.equipmentId, command.status);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: current.tenantId,
        userId: null, // system-triggered (the health poller), not a user action
        sessionId: null,
        action: AuditAction.EQUIPMENT_UPDATED,
        resourceType: "Equipment",
        resourceId: current.id,
        details: { previousStatus: current.status, newStatus: command.status },
      })
    );
  }
}
