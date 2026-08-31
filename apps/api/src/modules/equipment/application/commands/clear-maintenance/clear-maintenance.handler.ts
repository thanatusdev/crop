import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { EquipmentStatus } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { UpdateEquipmentStatusCommand } from "../update-equipment-status/update-equipment-status.command.js";
import { ClearMaintenanceCommand } from "./clear-maintenance.command.js";

@CommandHandler(ClearMaintenanceCommand)
export class ClearMaintenanceHandler implements ICommandHandler<ClearMaintenanceCommand, void> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: ClearMaintenanceCommand): Promise<void> {
    const target = await this.equipment.findById(command.equipmentId);
    if (!target) throw new NotFoundError("Equipment", command.equipmentId);
    if (!target.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    if (!target.isInMaintenance()) return; // idempotent

    // Reverts to OFFLINE, not directly back to ONLINE: this handler has no way to know the
    // device's *actual* current reachability without performing a real health check itself,
    // and guessing ONLINE would be a lie PiKvmHealthPoller's very next cycle (at most 10s
    // later, since this equipment is no longer filtered out of polling) will either confirm
    // or correct anyway. OFFLINE is the honest "we don't know yet" state in the meantime.
    await this.commandBus.execute(new UpdateEquipmentStatusCommand(target.id, EquipmentStatus.OFFLINE, command.actingUserId));
  }
}
