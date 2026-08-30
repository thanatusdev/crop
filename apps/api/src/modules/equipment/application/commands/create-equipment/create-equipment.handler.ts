import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { EncryptionService } from "../../../../../shared/infrastructure/crypto/encryption.service.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { CreateEquipmentCommand } from "./create-equipment.command.js";

@CommandHandler(CreateEquipmentCommand)
export class CreateEquipmentHandler implements ICommandHandler<CreateEquipmentCommand, Equipment> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly encryption: EncryptionService
  ) {}

  async execute(command: CreateEquipmentCommand): Promise<Equipment> {
    // PiKVM credentials are encrypted the moment they leave this handler and are never
    // persisted, logged, or returned in plaintext again -- see EncryptionService.
    return this.equipment.create({
      tenantId: command.tenantId,
      name: command.name,
      pikvmHost: command.pikvmHost,
      pikvmUser: command.pikvmUser,
      pikvmPasswordCiphertext: this.encryption.encrypt(command.pikvmPassword),
      pikvmTotpSecretCiphertext: command.pikvmTotpSecret ? this.encryption.encrypt(command.pikvmTotpSecret) : null,
      targetOs: command.targetOs,
      keymap: command.keymap,
      mouseMode: command.mouseMode,
      screenWidth: command.screenWidth,
      screenHeight: command.screenHeight,
      cameraUrl: command.cameraUrl,
    });
  }
}
