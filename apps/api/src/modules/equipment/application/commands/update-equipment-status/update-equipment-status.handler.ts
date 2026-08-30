import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { UpdateEquipmentStatusCommand } from "./update-equipment-status.command.js";

@CommandHandler(UpdateEquipmentStatusCommand)
export class UpdateEquipmentStatusHandler implements ICommandHandler<UpdateEquipmentStatusCommand, void> {
  constructor(@Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort) {}

  async execute(command: UpdateEquipmentStatusCommand): Promise<void> {
    await this.equipment.updateStatus(command.equipmentId, command.status);
  }
}
