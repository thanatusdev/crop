import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { EquipmentStatus } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { UpdateEquipmentStatusCommand } from "../update-equipment-status/update-equipment-status.command.js";
import { EnterMaintenanceCommand } from "./enter-maintenance.command.js";

@CommandHandler(EnterMaintenanceCommand)
export class EnterMaintenanceHandler implements ICommandHandler<EnterMaintenanceCommand, void> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: EnterMaintenanceCommand): Promise<void> {
    const target = await this.equipment.findById(command.equipmentId);
    if (!target) throw new NotFoundError("Equipment", command.equipmentId);
    if (!target.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    // Delegates to UpdateEquipmentStatusCommand rather than writing the status directly --
    // this is the one place both PiKvmHealthPoller's automatic transitions and this manual
    // one funnel through the same handler, so the audit dispatch and (see the real-time-push
    // phase) the EQUIPMENT_STATUS_CHANGED broadcast both fire correctly here too, not just
    // for poller-driven changes. UpdateEquipmentStatusHandler's own no-op-if-unchanged guard
    // makes this safely idempotent for free.
    await this.commandBus.execute(new UpdateEquipmentStatusCommand(target.id, EquipmentStatus.MAINTENANCE, command.actingUserId));
  }
}
